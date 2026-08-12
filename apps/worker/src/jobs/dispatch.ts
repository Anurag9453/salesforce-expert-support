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

// ── Interest-pool dispatch ───────────────────────────────────────────────────

export interface InterestWindowClosePayload {
  supportRequestId: string;
}

/**
 * Close the interest window and put the shortlist in front of the customer.
 *
 * Idempotent: the service refuses anything that is no longer SEARCHING, so a
 * duplicate delivery finds the round already settled and does nothing. A
 * request with nobody interested falls through to the relaxation ladder — the
 * same route the exclusive loop takes when everybody declines.
 */
export async function handleInterestWindowClose(
  container: WorkerContainer,
  payload: InterestWindowClosePayload,
): Promise<void> {
  const outcome = await container.matching.closeInterestWindow(payload.supportRequestId);
  container.logger.info("interest window closed", {
    supportRequestId: payload.supportRequestId,
    action: outcome.action,
    reason: outcome.reason,
  });
}

export interface ConfirmationTimeoutPayload {
  supportRequestId: string;
  attemptId: string;
}

/**
 * The chosen expert's two minutes are up.
 *
 * Reads the stored deadline rather than trusting the job's timing — a duplicate
 * delivery, or one that fires early after a restart, returns NOT_YET_DUE instead
 * of cutting someone's window short.
 */
export async function handleConfirmationTimeout(
  container: WorkerContainer,
  payload: ConfirmationTimeoutPayload,
): Promise<void> {
  const result = await container.matching.lapseConfirmation(payload.attemptId);
  container.logger.info("confirmation window settled", {
    supportRequestId: payload.supportRequestId,
    attemptId: payload.attemptId,
    action: result.action,
  });
}

/**
 * Backstop for lost confirmation-timeout jobs.
 *
 * Same reasoning as `reconcileOffers`: a transactional enqueue should never go
 * missing, but a customer stuck watching a countdown that already finished is
 * not a good thing to leave depending on "should never".
 */
export async function reconcileConfirmations(container: WorkerContainer): Promise<void> {
  const { lapsed } = await container.matching.reconcileLapsedConfirmations();
  if (lapsed > 0) {
    container.logger.warn("swept lapsed confirmations", { lapsed });
  }
}
