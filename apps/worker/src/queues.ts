/**
 * The job catalogue.
 *
 * Every durable timer in the product lives here (D2). These cannot be
 * setTimeout in a request handler: the 60-second offer window and the
 * 15-minute matching window must survive a deploy, a crash, and an expert
 * closing their laptop.
 *
 * pg-boss is Postgres-backed, so a job can be enqueued inside the same
 * transaction as the state change that warrants it. A request can never commit
 * as OFFERED with its timeout job lost.
 */

export const QUEUES = {
  /** §8 — classify, or fall back to customer-selected skills. Phase 3. */
  CLASSIFY_REQUEST: "classify-request",
  /** §15 — rank, offer to the next candidate. Phase 5. */
  DISPATCH_NEXT_OFFER: "dispatch-next-offer",
  /** §15 — 60s offer expiry. Phase 5. */
  OFFER_TIMEOUT: "offer-timeout",
  /** §15 — 15-minute give-up, voids the authorization. Phase 5. */
  MATCHING_DEADLINE: "matching-deadline",
  /** Close the interest window and assemble the shortlist. Interest-pool mode. */
  INTEREST_WINDOW_CLOSE: "interest-window-close",
  /** The chosen expert's 2-minute confirmation window. Interest-pool mode. */
  CONFIRMATION_TIMEOUT: "confirmation-timeout",
  /** §C4 — sweep stale-available experts offline. Phase 4. */
  CRM_SYNC: "crm-sync",
  HEARTBEAT_SWEEP: "heartbeat-sweep",
  /** §18 — deliver queued notifications. Phase 6. */
  NOTIFICATION_DISPATCH: "notification-dispatch",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface JobPayloads {
  [QUEUES.CLASSIFY_REQUEST]: { supportRequestId: string };
  [QUEUES.DISPATCH_NEXT_OFFER]: { supportRequestId: string; matchingRunId: string };
  [QUEUES.OFFER_TIMEOUT]: { supportRequestId: string; matchingAttemptId: string };
  [QUEUES.MATCHING_DEADLINE]: { supportRequestId: string };
  [QUEUES.INTEREST_WINDOW_CLOSE]: { supportRequestId: string };
  [QUEUES.CONFIRMATION_TIMEOUT]: { supportRequestId: string; attemptId: string };
  [QUEUES.CRM_SYNC]: { leadId: string };
  [QUEUES.HEARTBEAT_SWEEP]: Record<string, never>;
  [QUEUES.NOTIFICATION_DISPATCH]: { notificationId: string };
}

/**
 * Retry policy per queue.
 *
 * Deliberately conservative on the dispatch path: retrying an offer is not free
 * — it consumes an expert's attention and part of a 15-minute budget. The
 * matching deadline is the real backstop, so a failed dispatch is better
 * surfaced to an operator than silently retried into the ground.
 */
export const RETRY_POLICY: Record<QueueName, { retryLimit: number; retryDelaySeconds: number }> = {
  [QUEUES.CLASSIFY_REQUEST]: { retryLimit: 1, retryDelaySeconds: 2 },
  [QUEUES.DISPATCH_NEXT_OFFER]: { retryLimit: 2, retryDelaySeconds: 3 },
  [QUEUES.OFFER_TIMEOUT]: { retryLimit: 3, retryDelaySeconds: 5 },
  [QUEUES.MATCHING_DEADLINE]: { retryLimit: 3, retryDelaySeconds: 5 },
  // Both are safe to retry: each reads a stored deadline and every write is
  // guarded on the current status, so a second run finds nothing left to do.
  [QUEUES.INTEREST_WINDOW_CLOSE]: { retryLimit: 3, retryDelaySeconds: 5 },
  [QUEUES.CONFIRMATION_TIMEOUT]: { retryLimit: 3, retryDelaySeconds: 5 },
  // Generous, and the opposite of the dispatch path's reasoning. A retry costs
  // nobody's attention, the push is idempotent, and the alternative to trying
  // again is an enquiry that silently never reaches the sales team. Backoff is
  // long enough to ride out a Salesforce maintenance window.
  [QUEUES.CRM_SYNC]: { retryLimit: 8, retryDelaySeconds: 60 },
  [QUEUES.HEARTBEAT_SWEEP]: { retryLimit: 0, retryDelaySeconds: 0 },
  [QUEUES.NOTIFICATION_DISPATCH]: { retryLimit: 3, retryDelaySeconds: 30 },
};
