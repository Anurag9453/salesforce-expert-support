import type { WorkerContainer } from "../container.js";

/**
 * The dispatch handlers (§15).
 *
 * Every one of these is idempotent, because pg-boss guarantees at-least-once
 * delivery and a worker that restarts mid-job will see the same payload again.
 * The idempotency does not live here — it lives in `MatchingService`, which
 * guards every write on the state it read. These handlers are thin on purpose:
 * they translate a job into a service call and log what happened.
 */

export interface DispatchNextOfferPayload {
  supportRequestId: string;
}

export interface OfferTimeoutPayload {
  supportRequestId: string;
  matchingAttemptId: string;
}

export interface MatchingDeadlinePayload {
  supportRequestId: string;
}

export async function handleDispatchNextOffer(
  container: WorkerContainer,
  payload: DispatchNextOfferPayload,
): Promise<void> {
  const outcome = await container.matching.dispatchNextOffer(payload.supportRequestId);
  container.logger.info("dispatch", {
    supportRequestId: payload.supportRequestId,
    action: outcome.action,
    expertProfileId: outcome.attempt?.expertProfileId,
    relaxationLevel: outcome.relaxationLevel,
  });
}

/**
 * The 60-second offer window.
 *
 * Note what is absent: any arithmetic. The deadline was stored on the attempt
 * when the offer opened, so a duplicate delivery or a replay after a restart
 * cannot hand the expert a fresh window (requirement 8). The service reads the
 * stored value and refuses to act early.
 */
export async function handleOfferTimeout(
  container: WorkerContainer,
  payload: OfferTimeoutPayload,
): Promise<void> {
  const result = await container.matching.expireOffer(payload.matchingAttemptId);
  container.logger.info("offer timeout", {
    supportRequestId: payload.supportRequestId,
    matchingAttemptId: payload.matchingAttemptId,
    expired: result.expired,
    reason: result.reason,
  });
}

/**
 * The 15-minute matching deadline.
 *
 * Measured from submission to acceptance and never reset (requirement 7). This
 * job is a backstop rather than the authority — `matchDeadlineAt` is, and every
 * dispatch re-reads it — so arriving late is harmless.
 */
export async function handleMatchingDeadline(
  container: WorkerContainer,
  payload: MatchingDeadlinePayload,
): Promise<void> {
  const result = await container.matching.expireMatching(payload.supportRequestId);
  if (result.gaveUp) {
    container.logger.warn("matching window elapsed", {
      supportRequestId: payload.supportRequestId,
    });
  } else {
    container.logger.info("matching deadline job was a no-op", {
      supportRequestId: payload.supportRequestId,
      reason: result.reason,
    });
  }
}

/**
 * Withdraw offers held by experts who became ineligible (requirement 14).
 *
 * Runs on the same janitor interval as the presence sweep, and deliberately
 * after it: the sweep marks stale experts OFFLINE, and this notices the ones who
 * were holding an offer when it happened. Phase 4 left that case open because it
 * had nothing to re-dispatch with.
 */
export async function reconcileOffers(container: WorkerContainer): Promise<void> {
  const { withdrawn } = await container.matching.reconcileStaleOffers();
  if (withdrawn > 0) {
    container.logger.warn("withdrew offers from ineligible experts", { withdrawn });
  }
}

/**
 * Re-dispatch searches that went quiet (requirement 14).
 *
 * The classification sweep's sibling, and there for the same reason: a
 * transactional enqueue *should* never be lost, but "should never" is a poor
 * thing to leave a paid request depending on.
 */
export async function recoverStalledSearches(container: WorkerContainer): Promise<void> {
  const { recovered } = await container.matching.recoverStalledSearches();
  if (recovered > 0) {
    container.logger.warn("recovered stalled searches", { recovered });
  }
}
