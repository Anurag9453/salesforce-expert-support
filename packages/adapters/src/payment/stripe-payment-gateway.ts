import type {
  AuthorizeRequest,
  Authorization,
  Capture,
  Logger,
  PaymentGateway,
  PaymentWebhookEvent,
  RefundRequest,
  RefundResult,
} from "@sfx/domain";
import type { CurrencyCode } from "@sfx/contracts";
import Stripe from "stripe";

/**
 * Stripe, as the customer-side gateway.
 *
 * ## Authorize-then-capture, not charge
 *
 * D1 says payment is authorized before matching, so every intent is created with
 * `capture_method: "manual"`. Stripe holds the funds and we take them only when a
 * session actually happens. If no expert is found the hold is *cancelled*, which
 * the customer sees as the pending amount dropping off — far better than a charge
 * followed by a refund, which takes days and looks like a mistake.
 *
 * ## Idempotency is not optional
 *
 * Every mutating call passes the caller's idempotency key straight to Stripe.
 * The first bug any payment integration produces is a double charge on a retried
 * request, and Stripe's idempotency layer is the only thing that makes a retry
 * safe. The keys come from the domain, which derives them from the request id,
 * so a replayed job produces the same key rather than a new one.
 *
 * ## Minor units
 *
 * Stripe wants the smallest currency unit, which is what the whole codebase
 * already stores — so amounts pass through untouched. The one trap is
 * zero-decimal currencies (JPY, KRW), where Stripe's "smallest unit" is the whole
 * currency unit. None of USD, GBP or INR is zero-decimal, but the guard is here
 * so adding one later fails loudly rather than charging 100x.
 */

/**
 * Currencies where Stripe's smallest unit is the currency unit itself.
 *
 * Not exhaustive — it does not need to be. It exists so that
 * `assertSupportedCurrency` can refuse anything on the list, because our
 * minor-unit convention would silently multiply the amount by 100.
 */
const ZERO_DECIMAL = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

function assertSupportedCurrency(currency: CurrencyCode): void {
  if (ZERO_DECIMAL.has(currency)) {
    throw new RangeError(
      `${currency} is a zero-decimal currency in Stripe. Our amounts are in minor units, so passing one through unchanged would charge 100x. Handle it explicitly before enabling this currency.`,
    );
  }
}

export interface StripePaymentGatewayOptions {
  readonly secretKey: string;
  /** From the Stripe CLI or dashboard. Without it, webhooks cannot be trusted. */
  readonly webhookSecret: string;
  readonly logger: Logger;
  /** Injectable so tests can drive the adapter without network access. */
  readonly client?: Stripe;
}

export class StripePaymentGateway implements PaymentGateway {
  readonly name = "stripe";

  private readonly stripe: Stripe;
  private readonly webhookSecret: string;
  private readonly logger: Logger;

  constructor(options: StripePaymentGatewayOptions) {
    this.stripe =
      options.client ??
      new Stripe(options.secretKey, {
        // Pinned rather than floating. An account-level API upgrade in the
        // dashboard must not silently change response shapes under a running
        // deployment.
        apiVersion: "2026-07-29.dahlia",
        typescript: true,
        maxNetworkRetries: 2,
      });
    this.webhookSecret = options.webhookSecret;
    this.logger = options.logger;
  }

  async authorize(request: AuthorizeRequest): Promise<Authorization> {
    assertSupportedCurrency(request.currency);

    try {
      const intent = await this.stripe.paymentIntents.create(
        {
          amount: request.amountMinor,
          currency: request.currency.toLowerCase(),
          capture_method: "manual",
          confirm: false,
          description: request.description,
          ...(request.customerRef ? { customer: request.customerRef } : {}),
          // Stripe metadata values must be strings; the port already requires that.
          metadata: { ...request.metadata },
          automatic_payment_methods: { enabled: true },
        },
        { idempotencyKey: request.idempotencyKey },
      );

      return this.describeIntent(intent, request);
    } catch (error) {
      // A declined card is an expected outcome, not an exception the caller
      // should have to catch. Anything else is a real fault and is rethrown.
      if (error instanceof Stripe.errors.StripeCardError) {
        return {
          providerRef: error.payment_intent?.id ?? "",
          provider: this.name,
          status: "failed",
          amountMinor: request.amountMinor,
          currency: request.currency,
          ...(error.code ? { failureCode: error.code } : {}),
          failureMessage: error.message,
        };
      }
      throw error;
    }
  }

  async capture(
    authorizationRef: string,
    amountMinor: number,
    idempotencyKey: string,
  ): Promise<Capture> {
    const intent = await this.stripe.paymentIntents.capture(
      authorizationRef,
      // Capturing less than authorized is legitimate — a session that ran short.
      // Capturing more is not, and Stripe rejects it rather than us guessing.
      { amount_to_capture: amountMinor },
      { idempotencyKey },
    );

    return {
      providerRef: intent.id,
      capturedMinor: intent.amount_received,
      // `created` is seconds; the domain works in Date.
      capturedAt: new Date(intent.created * 1000),
    };
  }

  async void(authorizationRef: string, idempotencyKey: string): Promise<void> {
    try {
      await this.stripe.paymentIntents.cancel(authorizationRef, undefined, { idempotencyKey });
    } catch (error) {
      // Already cancelled, or already captured and therefore not cancellable.
      // Voiding is called on give-up paths that may be retried, so an intent
      // that is already in a terminal state is success, not failure.
      if (error instanceof Stripe.errors.StripeInvalidRequestError) {
        this.logger.warn("void skipped; the intent was no longer cancellable", {
          authorizationRef,
          code: error.code ?? "unknown",
        });
        return;
      }
      throw error;
    }
  }

  async refund(request: RefundRequest): Promise<RefundResult> {
    const refund = await this.stripe.refunds.create(
      {
        payment_intent: request.captureRef,
        amount: request.amountMinor,
        metadata: { reason: request.reason },
      },
      { idempotencyKey: request.idempotencyKey },
    );

    return {
      providerRef: refund.id,
      amountMinor: refund.amount,
      status:
        refund.status === "succeeded"
          ? "succeeded"
          : refund.status === "failed"
            ? "failed"
            : "pending",
    };
  }

  /**
   * Verify and normalise a webhook.
   *
   * Signature verification is the whole point. Without it anyone who learns the
   * endpoint URL can post `payment_intent.succeeded` and get a session for free,
   * so an unverified body is refused before it is even parsed.
   *
   * Returns null rather than throwing (per the port): a hostile request is not
   * an exceptional condition, it is Tuesday. The route answers 400 and moves on.
   */
  parseWebhook(
    rawBody: string,
    headers: Readonly<Record<string, string>>,
  ): PaymentWebhookEvent | null {
    // Header names arrive lowercased from Node, but a caller might not.
    const signature = headers["stripe-signature"] ?? headers["Stripe-Signature"];
    if (!signature) return null;

    try {
      const event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
      return {
        provider: this.name,
        externalEventId: event.id,
        eventType: event.type,
        payload: event.data.object,
        occurredAt: new Date(event.created * 1000),
      };
    } catch (error) {
      // Includes an expired timestamp, which is Stripe's replay protection.
      this.logger.warn("rejected a webhook that failed signature verification", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private describeIntent(intent: Stripe.PaymentIntent, request: AuthorizeRequest): Authorization {
    /*
      Stripe's intent statuses do not map one-to-one onto ours, and the mapping
      is where a payment integration quietly goes wrong. Being explicit:

        requires_capture         -> authorized. Funds held, ours to take.
        requires_action          -> requires_action. 3DS; the customer must act.
        requires_payment_method  -> requires_action for a fresh intent, because
                                    we created it unconfirmed and the customer
                                    has simply not paid yet. It is NOT a failure.
        requires_confirmation    -> requires_action, same reasoning.
        canceled / anything else -> failed.
    */
    const status: Authorization["status"] =
      intent.status === "requires_capture" || intent.status === "succeeded"
        ? "authorized"
        : intent.status === "requires_action" ||
            intent.status === "requires_payment_method" ||
            intent.status === "requires_confirmation" ||
            intent.status === "processing"
          ? "requires_action"
          : "failed";

    return {
      providerRef: intent.id,
      provider: this.name,
      status,
      amountMinor: intent.amount,
      currency: request.currency,
      // The browser needs this to complete 3DS. It is a client secret, not a
      // server key — safe to hand to the customer's own browser and nowhere else.
      ...(intent.client_secret && status === "requires_action"
        ? { clientActionToken: intent.client_secret }
        : {}),
      ...(intent.last_payment_error?.code ? { failureCode: intent.last_payment_error.code } : {}),
      ...(intent.last_payment_error?.message
        ? { failureMessage: intent.last_payment_error.message }
        : {}),
    };
  }
}
