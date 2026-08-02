import { randomUUID } from "node:crypto";
import type {
  PayoutProvider,
  PayoutRecipient,
  PayoutRecipientRequest,
  PayoutRequest,
  PayoutResult,
} from "@sfx/domain";

/**
 * In-memory PayoutProvider for Phases 1–7a (§C2).
 *
 * Models the one behaviour that actually bites in production: a recipient is
 * NOT payable the moment they are created. Real providers gate payouts behind
 * KYC and tax-form collection, so `payoutsEnabled` starts false and a payout
 * attempt before onboarding completes fails rather than silently succeeding.
 */
export class MockPayoutProvider implements PayoutProvider {
  readonly name = "mock";

  private readonly recipients = new Map<string, PayoutRecipient>();
  private readonly payouts = new Map<string, PayoutResult>();
  private readonly idempotency = new Map<string, string>();

  async createRecipient(request: PayoutRecipientRequest): Promise<PayoutRecipient> {
    const recipient: PayoutRecipient = {
      recipientRef: `mock_rcpt_${randomUUID()}`,
      provider: this.name,
      payoutsEnabled: false,
      onboardingUrl: `https://mock.invalid/onboard/${request.expertId}`,
    };
    this.recipients.set(recipient.recipientRef, recipient);
    return recipient;
  }

  async getRecipient(recipientRef: string): Promise<PayoutRecipient | null> {
    return this.recipients.get(recipientRef) ?? null;
  }

  /** Test helper: simulate the provider finishing KYC. */
  completeOnboarding(recipientRef: string): void {
    const existing = this.recipients.get(recipientRef);
    if (!existing) throw new Error(`Unknown recipient ${recipientRef}.`);
    this.recipients.set(recipientRef, {
      ...existing,
      payoutsEnabled: true,
      onboardingUrl: undefined,
    });
  }

  async payout(request: PayoutRequest): Promise<PayoutResult> {
    const replayedRef = this.idempotency.get(request.idempotencyKey);
    if (replayedRef !== undefined) {
      const replayed = this.payouts.get(replayedRef);
      // A recorded idempotency key with no payout behind it means the two maps
      // have diverged — fail loudly rather than silently paying twice.
      if (!replayed) throw new Error(`Idempotency key resolved to unknown payout ${replayedRef}.`);
      return replayed;
    }

    const recipient = this.recipients.get(request.recipientRef);
    if (!recipient) throw new Error(`Unknown recipient ${request.recipientRef}.`);

    const ref = `mock_payout_${randomUUID()}`;
    const result: PayoutResult = recipient.payoutsEnabled
      ? { providerRef: ref, status: "settled" }
      : { providerRef: ref, status: "failed", failureReason: "recipient_onboarding_incomplete" };

    this.payouts.set(ref, result);
    this.idempotency.set(request.idempotencyKey, ref);
    return result;
  }

  async getPayoutStatus(providerRef: string): Promise<PayoutResult> {
    const result = this.payouts.get(providerRef);
    if (!result) throw new Error(`Unknown payout ${providerRef}.`);
    return result;
  }
}
