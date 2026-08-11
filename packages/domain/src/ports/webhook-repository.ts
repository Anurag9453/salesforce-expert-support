import type { PaymentWebhookEvent } from "./payment.js";

/**
 * Durable record of provider webhooks.
 *
 * `record` returns whether the event was already known rather than throwing,
 * because a duplicate is the *expected* case: every payment provider delivers
 * at-least-once and retries on any non-2xx. Making the caller catch an exception
 * for normal operation would be the wrong shape.
 */
export interface WebhookEventRepository {
  /** Inserts, or reports that this provider event id has already been stored. */
  record(event: PaymentWebhookEvent): Promise<{ duplicate: boolean }>;
}
