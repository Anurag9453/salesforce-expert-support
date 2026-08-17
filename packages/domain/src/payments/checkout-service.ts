import { authorize, type Actor } from "../authorization/index.js";
import type { Clock } from "../ports/clock.js";
import type { Logger } from "../ports/logger.js";
import type { PaymentGateway } from "../ports/payment.js";
import type { PaymentRecord, PaymentRepository } from "../ports/payment-repository.js";
import type {
  SupportRequestRecord,
  SupportRequestRepository,
} from "../ports/request-repositories.js";
import type { AuditLogRepository } from "../ports/repositories.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import { assertTransition } from "../support-requests/state-machine.js";

/**
 * The customer pays, and the session becomes reachable.
 *
 * One step, deliberately: authorize and move to READY together. A separate
 * capture-on-completion step exists in the gateway port and belongs to the
 * session's close-out, not here — what this owns is the narrow question of
 * whether a meeting link may exist yet.
 *
 * ## Why this is its own service
 *
 * Payment used to happen inside request creation (D1: authorize before
 * matching), which was right when the platform chose the expert. Under the
 * shortlist flow the customer chooses, so there is nobody to hold money against
 * until they have chosen and that person has confirmed. Those are different
 * moments with different failure modes, and putting the second one back inside
 * `SupportRequestService` would have meant a create path that sometimes charges
 * and sometimes does not.
 *
 * ## What it refuses
 *
 * Everything except the owner of a request that is actually waiting for money.
 * Paying twice, paying someone else's request, paying one that already moved on
 * — each is a conflict rather than a second charge, because the alternative is
 * taking money for a session that will not happen.
 */

export interface CheckoutServiceDeps {
  readonly requests: SupportRequestRepository;
  readonly payments: PaymentRepository;
  readonly gateway: PaymentGateway;
  readonly auditLog: AuditLogRepository;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Fired after the request reaches READY, so the customer's screen updates. */
  readonly onReady?: (request: SupportRequestRecord) => Promise<void>;
}

export interface CheckoutView {
  readonly supportRequestId: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly durationMinutes: number;
  readonly status: "DUE" | "PAID" | "NOT_DUE";
  readonly payment: PaymentRecord | null;
}

export class CheckoutService {
  constructor(private readonly deps: CheckoutServiceDeps) {}

  /** What the customer owes, if anything. Safe to call in any state. */
  async summary(actor: Actor, supportRequestId: string): Promise<CheckoutView> {
    authorize(actor, "support_request:read_own");
    const request = await this.requireOwnRequest(actor, supportRequestId);
    const payment = await this.deps.payments.findForRequest(request.id);

    return {
      supportRequestId: request.id,
      amountCents: request.quotedPriceCents,
      currency: request.currency,
      durationMinutes: 0,
      status:
        request.state === "PAYMENT_PENDING"
          ? "DUE"
          : payment?.capturedAt
            ? "PAID"
            : payment
              ? "PAID"
              : "NOT_DUE",
      payment,
    };
  }

  /**
   * Take payment and open the session.
   *
   * The amount comes from the request's own quoted price — never from the
   * caller. A price in a request body is a price the customer can choose.
   */
  async pay(actor: Actor, supportRequestId: string): Promise<PaymentRecord> {
    authorize(actor, "support_request:read_own");
    const now = this.deps.clock.now();
    const request = await this.requireOwnRequest(actor, supportRequestId);

    if (request.state === "READY" || request.state === "IN_SESSION") {
      // Already paid. Returning the existing payment rather than erroring means
      // a double-submitted form lands the customer on their session instead of
      // on a failure they cannot act on.
      const existing = await this.deps.payments.findForRequest(request.id);
      if (existing) return existing;
    }

    if (request.state !== "PAYMENT_PENDING") {
      throw new ConflictError("This request is not waiting for payment.", { state: request.state });
    }

    const authorization = await this.deps.gateway.authorize({
      // Keyed on the request, not the clock: a retry must reach the same
      // authorization rather than create a second one.
      idempotencyKey: `checkout:${request.id}`,
      amountMinor: request.quotedPriceCents,
      currency: request.currency,
      customerRef: null,
      description: `Salesforce expert session`,
      metadata: { supportRequestId: request.id, customerId: request.customerId },
    });

    if (authorization.status === "failed") {
      await this.deps.payments.upsertForRequest({
        supportRequestId: request.id,
        customerId: request.customerId,
        provider: authorization.provider,
        providerRef: authorization.providerRef,
        amountCents: request.quotedPriceCents,
        currency: request.currency,
        status: "FAILED",
        authorizedAt: null,
        failureCode: authorization.failureCode ?? null,
        failureMessage: authorization.failureMessage ?? null,
      });
      // The request stays in PAYMENT_PENDING on purpose. A failed card is
      // something the customer can fix, and dropping their expert because of it
      // would be a far worse outcome than an error message.
      throw new ValidationError(authorization.failureMessage ?? "We could not take that payment.", {
        payment: [authorization.failureCode ?? "authorization_failed"],
      });
    }

    if (authorization.status === "requires_action") {
      // 3DS and equivalents. The row is recorded so the webhook can find it.
      return this.deps.payments.upsertForRequest({
        supportRequestId: request.id,
        customerId: request.customerId,
        provider: authorization.provider,
        providerRef: authorization.providerRef,
        amountCents: request.quotedPriceCents,
        currency: request.currency,
        status: "REQUIRES_METHOD",
        authorizedAt: null,
      });
    }

    const payment = await this.deps.payments.upsertForRequest({
      supportRequestId: request.id,
      customerId: request.customerId,
      provider: authorization.provider,
      providerRef: authorization.providerRef,
      amountCents: request.quotedPriceCents,
      currency: request.currency,
      status: "AUTHORIZED",
      authorizedAt: now,
    });

    await this.toReady(request, now, actor.userId);

    this.deps.logger.info("payment authorized; session is ready", {
      supportRequestId: request.id,
      provider: authorization.provider,
      amountCents: request.quotedPriceCents,
      currency: request.currency,
    });

    return payment;
  }

  /**
   * PAYMENT_PENDING → READY.
   *
   * SYSTEM, not CUSTOMER: the customer's act was paying, and the platform's act
   * is deciding that the payment is good enough to open a room. The state
   * machine reserves this edge for SYSTEM for that reason, and the customer is
   * still attributed through `actorUserId`.
   */
  private async toReady(
    request: SupportRequestRecord,
    now: Date,
    actorUserId: string,
  ): Promise<void> {
    assertTransition(request.state, "READY", "SYSTEM");
    const moved = await this.deps.requests.applyTransition({
      requestId: request.id,
      fromState: request.state,
      toState: "READY",
      expectedVersion: request.version,
      now,
      actorType: "SYSTEM",
      actorUserId,
      reason: "Payment received.",
    });
    if (!moved) {
      // Something else moved it between the read and the write — a cancellation,
      // or a second tab. The payment stands; the state does not.
      throw new ConflictError("This request changed while the payment was going through.", {
        supportRequestId: request.id,
      });
    }

    await this.deps.auditLog.record({
      actorType: "SYSTEM",
      actorUserId,
      action: "request.payment_confirmed",
      entityType: "SupportRequest",
      entityId: request.id,
      before: { state: request.state },
      after: { state: "READY" },
    });

    await this.deps.onReady?.(moved);
  }

  private async requireOwnRequest(
    actor: Actor,
    supportRequestId: string,
  ): Promise<SupportRequestRecord> {
    const request = await this.deps.requests.findById(supportRequestId);
    if (!request) throw new NotFoundError("SupportRequest", supportRequestId);
    if (!actor.customerProfileId || request.customerId !== actor.customerProfileId) {
      // Ownership, not a role. Guessing an id must not reveal that it exists.
      throw new ForbiddenError("support_request:read_own", `request:${supportRequestId}`);
    }
    return request;
  }
}
