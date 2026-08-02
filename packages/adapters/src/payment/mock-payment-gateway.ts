import { randomUUID } from "node:crypto";
import type {
  AuthorizeRequest,
  Authorization,
  Capture,
  PaymentGateway,
  PaymentWebhookEvent,
  RefundRequest,
  RefundResult,
} from "@sfx/domain";

/**
 * In-memory PaymentGateway for Phases 1–6 (§C2).
 *
 * This is not a stub that returns `true`. It enforces the same lifecycle a real
 * gateway does — you cannot capture a voided authorization, cannot capture
 * twice, cannot over-refund — so the D1 authorize-before-matching flow is
 * genuinely exercised before a provider is chosen in Phase 7a.
 *
 * Idempotency keys are honoured, because the first real bug a payment
 * integration produces is always a double charge on a retried request.
 */

type AuthState = "authorized" | "captured" | "voided";

interface AuthRecord {
  ref: string;
  amountMinor: number;
  currency: AuthorizeRequest["currency"];
  state: AuthState;
  capturedMinor: number;
  refundedMinor: number;
}

export interface MockPaymentGatewayOptions {
  /** Force `authorize` to fail — for exercising the failure path in tests. */
  readonly failAuthorizations?: boolean;
  /** Simulate 3DS by returning `requires_action` instead of `authorized`. */
  readonly requireAction?: boolean;
}

export class MockPaymentGateway implements PaymentGateway {
  readonly name = "mock";

  private readonly authorizations = new Map<string, AuthRecord>();
  private readonly idempotency = new Map<string, string>();

  constructor(private readonly options: MockPaymentGatewayOptions = {}) {}

  async authorize(request: AuthorizeRequest): Promise<Authorization> {
    const existingRef = this.idempotency.get(request.idempotencyKey);
    if (existingRef) {
      const existing = this.authorizations.get(existingRef);
      if (existing) return this.describe(existing);
    }

    if (this.options.failAuthorizations) {
      return {
        providerRef: `mock_auth_${randomUUID()}`,
        provider: this.name,
        status: "failed",
        amountMinor: request.amountMinor,
        currency: request.currency,
        failureCode: "card_declined",
        failureMessage: "Mock gateway configured to decline.",
      };
    }

    const record: AuthRecord = {
      ref: `mock_auth_${randomUUID()}`,
      amountMinor: request.amountMinor,
      currency: request.currency,
      state: "authorized",
      capturedMinor: 0,
      refundedMinor: 0,
    };
    this.authorizations.set(record.ref, record);
    this.idempotency.set(request.idempotencyKey, record.ref);

    if (this.options.requireAction) {
      return { ...this.describe(record), status: "requires_action", clientActionToken: "mock_3ds" };
    }
    return this.describe(record);
  }

  async capture(
    authorizationRef: string,
    amountMinor: number,
    idempotencyKey: string,
  ): Promise<Capture> {
    const record = this.require(authorizationRef);

    if (record.state === "captured") {
      // Idempotent replay, not an error — a retried webhook must not double-charge.
      if (this.idempotency.get(idempotencyKey) === authorizationRef) {
        return {
          providerRef: record.ref,
          capturedMinor: record.capturedMinor,
          capturedAt: new Date(),
        };
      }
      throw new Error(`Authorization ${authorizationRef} was already captured.`);
    }
    if (record.state === "voided") {
      throw new Error(`Cannot capture voided authorization ${authorizationRef}.`);
    }
    if (amountMinor > record.amountMinor) {
      throw new Error(
        `Capture ${amountMinor} exceeds authorized ${record.amountMinor} on ${authorizationRef}.`,
      );
    }

    record.state = "captured";
    record.capturedMinor = amountMinor;
    this.idempotency.set(idempotencyKey, authorizationRef);
    return { providerRef: record.ref, capturedMinor: amountMinor, capturedAt: new Date() };
  }

  async void(authorizationRef: string, _idempotencyKey: string): Promise<void> {
    const record = this.require(authorizationRef);
    if (record.state === "captured") {
      throw new Error(`Cannot void captured authorization ${authorizationRef}; refund instead.`);
    }
    record.state = "voided";
  }

  async refund(request: RefundRequest): Promise<RefundResult> {
    const record = this.require(request.captureRef);
    if (record.state !== "captured") {
      throw new Error(`Cannot refund uncaptured authorization ${request.captureRef}.`);
    }
    const remaining = record.capturedMinor - record.refundedMinor;
    if (request.amountMinor > remaining) {
      throw new Error(`Refund ${request.amountMinor} exceeds refundable ${remaining}.`);
    }
    record.refundedMinor += request.amountMinor;
    return {
      providerRef: `mock_refund_${randomUUID()}`,
      amountMinor: request.amountMinor,
      status: "succeeded",
    };
  }

  parseWebhook(
    rawBody: string,
    headers: Readonly<Record<string, string>>,
  ): PaymentWebhookEvent | null {
    // A real adapter verifies an HMAC here. The mock requires a shared header so
    // the "reject unsigned payloads" path is exercised rather than assumed.
    if (headers["x-mock-signature"] !== "valid") return null;
    try {
      const payload = JSON.parse(rawBody) as { id?: string; type?: string };
      if (!payload.id || !payload.type) return null;
      return {
        provider: this.name,
        externalEventId: payload.id,
        eventType: payload.type,
        payload,
        occurredAt: new Date(),
      };
    } catch {
      return null;
    }
  }

  private require(ref: string): AuthRecord {
    const record = this.authorizations.get(ref);
    if (!record) throw new Error(`Unknown authorization ${ref}.`);
    return record;
  }

  private describe(record: AuthRecord): Authorization {
    return {
      providerRef: record.ref,
      provider: this.name,
      status: record.state === "voided" ? "failed" : "authorized",
      amountMinor: record.amountMinor,
      currency: record.currency,
    };
  }
}
