import type { PrismaClient, PrismaTransactionClient } from "@sfx/db";
import type { PaymentWebhookEvent, WebhookEventRepository } from "@sfx/domain";

type Db = PrismaClient | PrismaTransactionClient;

/**
 * Webhook events, deduplicated by the database rather than by a check.
 *
 * The unique constraint on (provider, externalEventId) is what makes this
 * idempotent. Reading first and then inserting would leave a window in which two
 * concurrent retries both see "not present" and both proceed — which for a
 * payment webhook means acting on the same event twice.
 *
 * So we insert unconditionally and treat the conflict as the answer.
 */
export class PrismaWebhookEventRepository implements WebhookEventRepository {
  constructor(private readonly db: Db) {}

  async record(event: PaymentWebhookEvent): Promise<{ duplicate: boolean }> {
    try {
      await this.db.webhookEvent.create({
        data: {
          provider: event.provider,
          externalEventId: event.externalEventId,
          eventType: event.eventType,
          payload: event.payload as object,
        },
      });
      return { duplicate: false };
    } catch (error) {
      // P2002 is Prisma's unique-constraint violation: we have seen this event.
      // Anything else is a real fault and must not be mistaken for a duplicate,
      // because that would silently drop an event we never recorded.
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "P2002"
      ) {
        return { duplicate: true };
      }
      throw error;
    }
  }
}
