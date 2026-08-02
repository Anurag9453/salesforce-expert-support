import type { CurrencyCode } from "@sfx/contracts";

/**
 * Platform → expert. Separate from PaymentGateway on purpose (§C2).
 *
 * This is the harder axis for an India-based platform: domestic INR payouts and
 * cross-border payouts to experts abroad may need different providers, and the
 * answer depends on the entity, the customer geography, and the expert
 * geography (Q3). Implemented in Phase 7b.
 */

export interface PayoutRecipientRequest {
  readonly expertId: string;
  readonly legalName: string;
  readonly email: string;
  readonly country: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface PayoutRecipient {
  readonly recipientRef: string;
  readonly provider: string;
  /** False until the provider has completed KYC and any tax-form collection. */
  readonly payoutsEnabled: boolean;
  /** Provider-hosted onboarding URL, when the flow is not yet complete. */
  readonly onboardingUrl?: string;
}

export interface PayoutRequest {
  readonly idempotencyKey: string;
  readonly recipientRef: string;
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
  readonly description: string;
}

export type PayoutStatus = "pending" | "in_transit" | "settled" | "failed" | "returned";

export interface PayoutResult {
  readonly providerRef: string;
  readonly status: PayoutStatus;
  readonly failureReason?: string;
}

export interface PayoutProvider {
  readonly name: string;
  createRecipient(request: PayoutRecipientRequest): Promise<PayoutRecipient>;
  getRecipient(recipientRef: string): Promise<PayoutRecipient | null>;
  payout(request: PayoutRequest): Promise<PayoutResult>;
  getPayoutStatus(providerRef: string): Promise<PayoutResult>;
}
