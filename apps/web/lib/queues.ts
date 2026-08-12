/**
 * Queue names the web app enqueues into.
 *
 * Duplicated from apps/worker/src/queues.ts on purpose: the web app must not
 * import the worker's module graph (pg-boss handlers, the classifier), and a
 * shared package for six string constants would be more indirection than the
 * duplication costs. A mismatch surfaces immediately as a job nothing consumes.
 */
export const QUEUES = {
  CLASSIFY_REQUEST: "classify-request",
  DISPATCH_NEXT_OFFER: "dispatch-next-offer",
  OFFER_TIMEOUT: "offer-timeout",
  MATCHING_DEADLINE: "matching-deadline",
  INTEREST_WINDOW_CLOSE: "interest-window-close",
  CONFIRMATION_TIMEOUT: "confirmation-timeout",
  HEARTBEAT_SWEEP: "heartbeat-sweep",
  NOTIFICATION_DISPATCH: "notification-dispatch",
} as const;
