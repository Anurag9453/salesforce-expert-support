import { parseServerEnv } from "@sfx/contracts";
import { ConsoleLogger } from "@sfx/adapters";
import { prisma } from "@sfx/db";
import PgBoss from "pg-boss";
import { buildWorkerContainer } from "./container.js";
import {
  handleClassifyRequest,
  sweepStuckClassifications,
  type ClassifyRequestPayload,
} from "./jobs/classify-request.js";
import { runHeartbeatSweep, SWEEP_INTERVAL_MS } from "./jobs/heartbeat-sweep.js";
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

  // Migrations run through the direct (unpooled) connection; pg-boss holds
  // long-lived listeners, which a transaction pooler would break.
  const connectionString = env.DIRECT_DATABASE_URL ?? env.DATABASE_URL;

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
  //   Phase 4 → HEARTBEAT_SWEEP
  //   Phase 5 → DISPATCH_NEXT_OFFER, OFFER_TIMEOUT, MATCHING_DEADLINE
  //   Phase 6 → NOTIFICATION_DISPATCH
  const container = await buildWorkerContainer();

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
