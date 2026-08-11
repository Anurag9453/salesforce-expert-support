import type { Logger } from "../ports/logger.js";
import type { PaymentGateway, PaymentWebhookEvent } from "../ports/payment.js";
import type { WebhookEventRepository } from "../ports/webhook-repository.js";

/**
 * Verifying and recording payment webhooks.
 *
 * Two responsibilities, deliberately in this order:
 *
 *   1. **Verify.** The endpoint is public — a payment provider has no session —
 *      so the signature is the only thing between a stranger and a free session.
 *      Nothing is read from the body until it verifies.
 *   2. **Record exactly once.** Providers deliver at-least-once and retry on any
 *      non-2xx, so the same event will arrive more than once. Uniqueness on the
 *      provider's event id makes that a database invariant rather than an
 *      application check with a race in the middle.
 *
 * Acting on the event is deliberately not here. The transitions these should
 * drive belong to the payment lifecycle, and a service that half-transitions a
 * request is worse than one that faithfully records what happened and lets the
 * lifecycle catch up. The row is durable, so nothing is lost by waiting.
 */
export class PaymentWebhookService {
  constructor(
    private readonly deps: {
      readonly gateway: PaymentGateway;
      readonly events: WebhookEventRepository;
      readonly logger: Logger;
    },
  ) {}

  /**
   * `null` means the signature did not verify — the caller should answer 400 and
   * say nothing more, because a hostile caller should learn nothing about why.
   */
  async accept(
    rawBody: string,
    headers: Readonly<Record<string, string>>,
  ): Promise<{ event: PaymentWebhookEvent; duplicate: boolean } | null> {
    const event = this.deps.gateway.parseWebhook(rawBody, headers);
    if (!event) return null;

    const { duplicate } = await this.deps.events.record(event);
    this.deps.logger.info(duplicate ? "webhook retry acknowledged" : "webhook accepted", {
      provider: event.provider,
      externalEventId: event.externalEventId,
      eventType: event.eventType,
    });
    return { event, duplicate };
  }
}
