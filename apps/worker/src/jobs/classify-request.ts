import { prisma } from "@sfx/db";
import type { WorkerContainer } from "../container.js";
import { QUEUES } from "../queues.js";

/**
 * §8 — classify a request, then move it to SEARCHING.
 *
 * The handler is deliberately thin. All the behaviour that matters, including
 * every fallback, lives in `ClassificationService` where it is unit-testable
 * without a queue.
 */
export interface ClassifyRequestPayload {
  supportRequestId: string;
}

export async function handleClassifyRequest(
  container: WorkerContainer,
  payload: ClassifyRequestPayload,
): Promise<void> {
  const started = Date.now();
  const log = container.logger.child({
    job: QUEUES.CLASSIFY_REQUEST,
    supportRequestId: payload.supportRequestId,
  });

  const outcome = await container.classification.classify(payload.supportRequestId);

  log.info("classification complete", {
    classified: outcome.classified,
    skillsAttached: outcome.skillsAttached,
    failureReason: outcome.failureReason,
    state: outcome.request.state,
    durationMs: Date.now() - started,
  });
}

/**
 * Recovery sweep for requests stranded in CLASSIFYING.
 *
 * The enqueue is transactional, so a lost job should not happen — but "should
 * not happen" is a poor thing to leave a paying customer's request depending on.
 * A request stuck in CLASSIFYING never reaches matching and never gets refunded;
 * it simply sits there.
 *
 * This is a janitor, not the dispatch mechanism (§17 rules out polling for
 * dispatch, not for recovery). It runs on a slow cadence and only picks up
 * requests old enough that a healthy path would already have finished.
 */
export async function sweepStuckClassifications(
  container: WorkerContainer,
  olderThanSeconds = 60,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanSeconds * 1000);

  const stuck = await prisma.supportRequest.findMany({
    where: { state: "CLASSIFYING", stateEnteredAt: { lt: cutoff } },
    select: { id: true },
    take: 25,
  });

  if (stuck.length === 0) return 0;

  container.logger.warn("recovering requests stranded in CLASSIFYING", {
    count: stuck.length,
    olderThanSeconds,
  });

  for (const request of stuck) {
    try {
      await container.classification.classify(request.id);
    } catch (error) {
      container.logger.error("recovery failed for request", {
        supportRequestId: request.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return stuck.length;
}
