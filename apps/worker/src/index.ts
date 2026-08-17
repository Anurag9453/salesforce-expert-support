import { parseServerEnv } from "@sfx/contracts";
import { ConsoleLogger, PgBossScheduler } from "@sfx/adapters";
import { prisma } from "@sfx/db";
import PgBoss from "pg-boss";
import { buildWorkerContainer } from "./container.js";
import {
  handleClassifyRequest,
  sweepStuckClassifications,
  type ClassifyRequestPayload,
} from "./jobs/classify-request.js";
import { runHeartbeatSweep, SWEEP_INTERVAL_MS } from "./jobs/heartbeat-sweep.js";
import {
  handleConfirmationTimeout,
  handleDispatchNextOffer,
  handleInterestWindowClose,
  handleMatchingDeadline,
  handleOfferTimeout,
  reconcileConfirmations,
  reconcileOffers,
  recoverStalledSearches,
  type ConfirmationTimeoutPayload,
  type DispatchNextOfferPayload,
  type InterestWindowClosePayload,
  type MatchingDeadlinePayload,
  type OfferTimeoutPayload,
} from "./jobs/dispatch.js";
import { handleCrmSync, retryUnsyncedLeads, type CrmSyncPayload } from "./jobs/crm-sync.js";
import { QUEUES, RETRY_POLICY, type QueueName } from "./queues.js";

/**
 * Dispatch worker (D2).
 *
 * The product's core loop — offer → wait 60s → timeout → offer next → until
 * 15 minutes — is a sequence of durable timers. It cannot depend on a browser
 * staying open or a serverless handler continuing to execute, so it lives in
 * this always-on process with Postgres as the source of truth.
 *
 * Phase 1 establishes the runtime: queue registration, health, and a clean
 * shutdown that finishes in-flight work rather than abandoning it. Handlers
 * arrive with their phases.
 */

const env = parseServerEnv();
const logger = new ConsoleLogger(env.LOG_LEVEL, { service: "worker" });

async function main(): Promise<void> {
  logger.info("worker starting", { nodeEnv: env.NODE_ENV });

  /*
    pg-boss needs a session, not a pooled connection.

    It holds `LISTEN`ers open, takes advisory locks, and polls on a schedule.
    A transaction pooler hands each statement whichever backend is free, so the
    listener ends up on a connection nobody notifies and the advisory lock is
    released the moment the statement that took it returns. Neither fails loudly:
    the queue simply goes quiet, which is the worst way for a job runner to break.

    `WORKER_DATABASE_URL` first, so the worker can be pointed at its own role or
    a session-mode pooler without disturbing how migrations connect. The
    fallbacks keep local development on a single URL, where there is no pooler to
    route around.
  */
  const connectionString = env.WORKER_DATABASE_URL ?? env.DIRECT_DATABASE_URL ?? env.DATABASE_URL;
  const connectionSource = env.WORKER_DATABASE_URL
    ? "WORKER_DATABASE_URL"
    : env.DIRECT_DATABASE_URL
      ? "DIRECT_DATABASE_URL"
      : "DATABASE_URL";

  /*
    Logged by variable name, never by value — a connection string carries a
    password. Worth logging at all because "the worker is running but nothing
    happens" is the symptom of picking the pooled URL by accident, and this line
    is the difference between spotting that in seconds and in an afternoon.
  */
  logger.info("worker database connection", {
    source: connectionSource,
    pooled: connectionSource === "DATABASE_URL",
  });
  if (connectionSource === "DATABASE_URL" && env.NODE_ENV === "production") {
    logger.warn(
      "the worker is using the pooled DATABASE_URL in production — set WORKER_DATABASE_URL to an unpooled connection, or pg-boss will stall silently",
    );
  }

  const boss = new PgBoss({
    connectionString,
    schema: "pgboss",
    // Timers are the product. Poll fast enough that a 60s offer window is not
    // meaningfully skewed by queue latency.
    pollingIntervalSeconds: 1,
    // Keep completed jobs long enough to debug a dispatch that went wrong.
    archiveCompletedAfterSeconds: 60 * 60 * 24 * 7,
  });

  boss.on("error", (error: Error) => {
    logger.error("pg-boss error", { error: error.message, stack: error.stack });
  });

  await boss.start();
  logger.info("job queue ready", { schema: "pgboss" });

  // Register every queue up front so pg-boss creates its partitions at boot,
  // not lazily on first send. A queue that does not exist when a transaction
  // tries to enqueue into it is a lost job.
  for (const queue of Object.values(QUEUES) as QueueName[]) {
    const policy = RETRY_POLICY[queue];
    await boss.createQueue(queue, {
      name: queue,
      retryLimit: policy.retryLimit,
      retryDelay: policy.retryDelaySeconds,
      retryBackoff: false,
    });
  }
  logger.info("queues registered", { count: Object.keys(QUEUES).length });

  await verifyDatabase();

  // Handlers are registered by their phase:
  //   Phase 3 → CLASSIFY_REQUEST                                    ← live
  //   Phase 4 → HEARTBEAT_SWEEP (an interval, not a queue)           ← live
  //   Phase 5 → DISPATCH_NEXT_OFFER, OFFER_TIMEOUT, MATCHING_DEADLINE ← live
  //   Phase 6 → NOTIFICATION_DISPATCH
  //
  // The container enqueues through the boss this process already started, so
  // there is one connection pool rather than two.
  const container = await buildWorkerContainer(new PgBossScheduler(boss, logger));

  await boss.work<ClassifyRequestPayload>(
    QUEUES.CLASSIFY_REQUEST,
    { batchSize: 1 },
    async (jobs) => {
      for (const job of jobs) {
        await handleClassifyRequest(container, job.data);
      }
    },
  );
  logger.info("handler registered", { queue: QUEUES.CLASSIFY_REQUEST });

  // ── The dispatch loop (§15) ────────────────────────────────────────────────
  //
  // Three queues, one per timing fact. Each handler is idempotent: pg-boss
  // guarantees at-least-once delivery, and a duplicate must be a no-op rather
  // than a second offer or a fresh 60-second window.
  await boss.work<DispatchNextOfferPayload>(
    QUEUES.DISPATCH_NEXT_OFFER,
    { batchSize: 1 },
    async (jobs) => {
      for (const job of jobs) await handleDispatchNextOffer(container, job.data);
    },
  );

  await boss.work<OfferTimeoutPayload>(QUEUES.OFFER_TIMEOUT, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) await handleOfferTimeout(container, job.data);
  });

  await boss.work<MatchingDeadlinePayload>(
    QUEUES.MATCHING_DEADLINE,
    { batchSize: 1 },
    async (jobs) => {
      for (const job of jobs) await handleMatchingDeadline(container, job.data);
    },
  );
  // Interest-pool timers. Registered unconditionally: the queues are only ever
  // enqueued into when DISPATCH_MODE=interest_pool, and a handler with nothing
  // to consume costs nothing — whereas a mode flip with no consumer would strand
  // every request at its interest window.
  await boss.work<InterestWindowClosePayload>(
    QUEUES.INTEREST_WINDOW_CLOSE,
    { batchSize: 1 },
    async (jobs) => {
      for (const job of jobs) await handleInterestWindowClose(container, job.data);
    },
  );

  await boss.work<ConfirmationTimeoutPayload>(
    QUEUES.CONFIRMATION_TIMEOUT,
    { batchSize: 1 },
    async (jobs) => {
      for (const job of jobs) await handleConfirmationTimeout(container, job.data);
    },
  );

  // The current product's only real job. Registered unconditionally for the same
  // reason as the interest queues: a lead enqueued with no consumer is an
  // enquiry nobody is ever told about.
  await boss.work<CrmSyncPayload>(QUEUES.CRM_SYNC, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) await handleCrmSync(container, job.data);
  });
  logger.info("handler registered", { queue: QUEUES.CRM_SYNC });

  logger.info("dispatch handlers registered", {
    queues: [
      QUEUES.DISPATCH_NEXT_OFFER,
      QUEUES.OFFER_TIMEOUT,
      QUEUES.MATCHING_DEADLINE,
      QUEUES.INTEREST_WINDOW_CLOSE,
      QUEUES.CONFIRMATION_TIMEOUT,
    ],
  });

  // Recovery janitor, not a dispatch mechanism. Catches requests stranded in
  // CLASSIFYING if an enqueue is ever lost — a stuck request is invisible to
  // the customer and never resolves on its own.
  const sweepTimer = setInterval(() => {
    void sweepStuckClassifications(container).catch((error: unknown) => {
      logger.error("classification sweep failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, 30_000);
  sweepTimer.unref();

  // §C4 — take stale-available experts offline. Interval rather than a queued
  // job: nothing enqueues it, only time passing makes it due.
  const presenceTimer = setInterval(() => {
    void runHeartbeatSweep(container).catch((error: unknown) => {
      logger.error("heartbeat sweep failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, SWEEP_INTERVAL_MS);
  presenceTimer.unref();

  // Requirement 14, second half. Runs after the presence sweep on the same
  // cadence: the sweep marks stale experts OFFLINE, this notices the ones who
  // were holding an offer when it happened and gives the request back to the
  // dispatcher. Phase 4 deliberately left ON_OFFER alone because it had nothing
  // to re-dispatch with.
  const reconcileTimer = setInterval(() => {
    // The quietest failure in the product: an enquiry captured, durable, and
    // never mentioned to anyone because one job was lost.
    void retryUnsyncedLeads(container).catch((error: unknown) => {
      logger.error("lead CRM retry sweep failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    // Backstop for a lost confirmation-timeout job. A customer watching a
    // countdown that already finished is not a good thing to leave depending on
    // "an enqueue should never be lost".
    void reconcileConfirmations(container).catch((error: unknown) => {
      logger.error("confirmation reconciliation failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    void reconcileOffers(container).catch((error: unknown) => {
      logger.error("offer reconciliation failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, SWEEP_INTERVAL_MS);
  reconcileTimer.unref();

  const recoveryTimer = setInterval(() => {
    void recoverStalledSearches(container).catch((error: unknown) => {
      logger.error("stalled-search recovery failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, SWEEP_INTERVAL_MS);
  recoveryTimer.unref();

  logger.info("presence sweep scheduled", {
    everySeconds: SWEEP_INTERVAL_MS / 1000,
    staleAfterSeconds: env.HEARTBEAT_STALE_AFTER_SECONDS,
  });

  logger.info("worker ready");

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutdown requested", { signal });
    try {
      // Graceful: let in-flight handlers finish. Abandoning a job mid-dispatch
      // would leave a request OFFERED with no timer to rescue it.
      await boss.stop({ graceful: true, timeout: 30_000 });
      await prisma.$disconnect();
      logger.info("shutdown complete");
      process.exit(0);
    } catch (error) {
      logger.error("shutdown failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // A one-shot boot check is useful in CI; a long-running process is not.
  if (process.env.WORKER_BOOT_CHECK === "1") {
    logger.info("boot check passed, exiting");
    await boss.stop({ graceful: true, timeout: 5_000 });
    await prisma.$disconnect();
    process.exit(0);
  }
}

async function verifyDatabase(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
  logger.info("database reachable");
}

main().catch((error: unknown) => {
  logger.error("worker failed to start", {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
