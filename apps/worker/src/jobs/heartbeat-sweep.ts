import type { WorkerContainer } from "../container.js";

/**
 * Stale-presence sweep (§C4, requirement 5).
 *
 * An expert who closes their laptop while AVAILABLE stays AVAILABLE in the
 * database forever unless something notices. That expert then absorbs offers
 * and lets them time out, and every one of those 60-second windows comes out of
 * a customer's 15-minute budget. This job is what notices.
 *
 * It runs on an interval rather than as a scheduled pg-boss job because there is
 * nothing to enqueue it: no state change triggers a sweep, only the passage of
 * time. It is also idempotent and cheap — a re-run right after a run sweeps
 * nothing, since the rows it would have found are already OFFLINE.
 *
 * The sweep is one-directional. It can take an expert offline and can never put
 * one back — that asymmetry is requirement 5, and it lives in the domain service
 * and the `touchHeartbeat` port contract rather than here.
 */

export const SWEEP_INTERVAL_MS = 30_000;

/** Bounded so one pass cannot hold a connection for an unbounded time. */
const SWEEP_BATCH_LIMIT = 200;

export async function runHeartbeatSweep(container: WorkerContainer): Promise<void> {
  const { swept, skipped } = await container.availability.sweepStalePresence(SWEEP_BATCH_LIMIT);

  // Only speak up when something happened. A line every 30 seconds saying
  // "swept 0" buries the one that matters.
  if (swept > 0 || skipped > 0) {
    container.logger.info("heartbeat sweep complete", { swept, skipped });
  }
}
