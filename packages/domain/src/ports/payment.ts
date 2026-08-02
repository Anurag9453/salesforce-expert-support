import type { CurrencyCode } from "@sfx/contracts";

/**
 * Customer → platform. Deliberately NOT fused with PayoutProvider (§C2).
 *
 * Stripe Connect bundles collection and payout, which is exactly why one port
 * was wrong: collecting from Indian customers and paying experts in several
 * countries may well be two different providers. A single fused abstraction
 * would have quietly made that impossible.
 *
 * The provider is undecided until Phase 7a. Phases 1–6 run on MockPaymentGateway,
 * which exercises the full authorize-before-matching flow (D1) without one.
 */

export interface AuthorizeRequest {
  readonly idempotencyKey: string;
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
  readonly customerRef: string | null;
  readonly description: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface Authorization {
  readonly providerRef: string;
  readonly provider: string;
  readonly status: "authorized" | "requires_action" | "failed";
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
  /** Present when the customer must complete 3DS or an equivalent step. */
  readonly clientActionToken?: string;
  readonly failureCode?: string;
  readonly failureMessage?: string;
}

export interface Capture {
  readonly providerRef: string;
  readonly capturedMinor: number;
  readonly capturedAt: Date;
}

export interface RefundRequest {
  readonly idempotencyKey: string;
  readonly captureRef: string;
  readonly amountMinor: number;
  readonly reason: string;
}

export interface RefundResult {
  readonly providerRef: string;
  readonly amountMinor: number;
  readonly status: "pending" | "succeeded" | "failed";
}

/** Verified webhook, already signature-checked by the adapter. */
export interface PaymentWebhookEvent {
  readonly provider: string;
  readonly externalEventId: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly occurredAt: Date;
}

export interface PaymentGateway {
  readonly name: string;

  /** Hold funds without taking them. The D1 step, at request submission. */
  authorize(request: AuthorizeRequest): Promise<Authorization>;

  /** Take the held funds. Called on session completion. */
  capture(authorizationRef: string, amountMinor: number, idempotencyKey: string): Promise<Capture>;

  /** Release the hold. Called on NO_EXPERT_FOUND or customer cancellation. */
  void(authorizationRef: string, idempotencyKey: string): Promise<void>;

  refund(request: RefundRequest): Promise<RefundResult>;

  /**
   * Verify a webhook signature and normalise the payload.
   * Returns null when the signature does not verify — never throw on a
   * hostile request, just refuse it.
   */
  parseWebhook(
    rawBody: string,
    headers: Readonly<Record<string, string>>,
  ): PaymentWebhookEvent | null;
}
