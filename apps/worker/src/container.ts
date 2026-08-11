import {
  AnthropicProblemClassifier,
  ConsoleLogger,
  NoopRealtimeBus,
  PostgresRealtimeBus,
  PrismaCandidateRepository,
  PrismaExpertAvailabilityRepository,
  PrismaMatchingRepository,
  PrismaNotificationRepository,
  PrismaPricingRepository,
  PrismaSupportRequestRepository,
  PrismaTaxonomyRepository,
  RulesProblemClassifier,
} from "@sfx/adapters";
import { PrismaUnitOfWork } from "@sfx/adapters";
import { parseServerEnv, type ServerEnv } from "@sfx/contracts";
import { prisma } from "@sfx/db";
import {
  ClassificationService,
  DEFAULT_MATCHING_THRESHOLDS,
  DispatchNotifier,
  ExpertAvailabilityService,
  MatchingService,
  NotificationService,
  systemClock,
  type JobScheduler,
  type Logger,
  type ProblemClassifier,
  type SupportRequestRepository,
  type TaxonomyRepository,
} from "@sfx/domain";
import { QUEUES } from "./queues.js";

/**
 * Worker composition root.
 *
 * Separate from the web app's: the worker needs the classifier and the request
 * repositories, and has no business holding an auth client or a payment gateway
 * it never calls.
 */
export interface WorkerContainer {
  readonly env: ServerEnv;
  readonly logger: Logger;
  readonly requests: SupportRequestRepository;
  readonly taxonomy: TaxonomyRepository;
  readonly classification: ClassificationService;
  /**
   * Built with no actor and never exposed over HTTP from here — the sweep is the
   * system acting on itself. The web app builds its own instance for the
   * expert-facing toggle and heartbeat.
   */
  readonly availability: ExpertAvailabilityService;
  /** Stages 4 and 5 of matching. The worker is the only process that dispatches (D2). */
  readonly matching: MatchingService;
}

/**
 * The rules classifier needs the taxonomy's aliases, which live in the database,
 * so it is built per invocation from current data rather than at boot. That also
 * means adding a skill alias takes effect without a restart.
 */
async function buildClassifier(
  env: ServerEnv,
  logger: Logger,
  taxonomy: TaxonomyRepository,
): Promise<ProblemClassifier> {
  if (env.CLASSIFIER_PROVIDER === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) {
      // Explicit rather than silently degrading: someone who set the provider to
      // "anthropic" wants the model, and should be told why they are not getting it.
      logger.warn("CLASSIFIER_PROVIDER=anthropic but ANTHROPIC_API_KEY is unset — using rules");
    } else {
      return new AnthropicProblemClassifier({
        apiKey: env.ANTHROPIC_API_KEY,
        model: env.CLASSIFIER_MODEL,
        logger,
      });
    }
  }

  const skills = await taxonomy.listActiveSkills();
  return new RulesProblemClassifier({
    vocabulary: new Map(
      skills.map((skill) => [
        skill.slug,
        { name: skill.name, aliases: skill.aliases, categorySlug: skill.categorySlug },
      ]),
    ),
  });
}

/**
 * @param scheduler Built from the boss this process already started. Passing it
 * in rather than constructing a second `SendOnlyBoss` matters: the worker both
 * polls and enqueues, and a second connection pool for the same database would
 * be waste plus one more thing to shut down cleanly.
 */
export async function buildWorkerContainer(scheduler: JobScheduler): Promise<WorkerContainer> {
  const env = parseServerEnv();
  const logger = new ConsoleLogger(env.LOG_LEVEL, { service: "worker" });

  const requests = new PrismaSupportRequestRepository(prisma);
  const taxonomy = new PrismaTaxonomyRepository(prisma);
  void new PrismaPricingRepository(prisma);
  const matchingRepo = new PrismaMatchingRepository(prisma);
  const candidates = new PrismaCandidateRepository(prisma);

  // `mock` installs a bus that records and delivers nothing. That is a runnable
  // demonstration of requirement 10 rather than a stub: with it, every offer is
  // still created, still expires on time, and is still visible on the dashboard.
  const realtime = (() => {
    switch (env.REALTIME_PROVIDER) {
      case "mock":
        return new NoopRealtimeBus();
      case "postgres":
        return new PostgresRealtimeBus(
          // $executeRawUnsafe, NOT $queryRawUnsafe: pg_notify() returns void and
          // Prisma cannot deserialize a void column, so the query form fails
          // every single time. See the PostgresRealtimeBus class comment.
          (sql, params) => prisma.$executeRawUnsafe(sql, ...params),
          logger,
        );
      case "ably":
        // Deliberately a hard failure rather than a silent fallback: someone who
        // set this expects a hosted provider, and quietly giving them something
        // else is how a deployment ends up with the wrong assumptions.
        throw new Error("REALTIME_PROVIDER=ably has no adapter yet. Use postgres or mock.");
      default: {
        const never: never = env.REALTIME_PROVIDER;
        throw new Error(`Unsupported REALTIME_PROVIDER: ${String(never)}`);
      }
    }
  })();
  logger.info("realtime ready", { provider: realtime.name });

  const classifier = await buildClassifier(env, logger, taxonomy);
  logger.info("classifier ready", { provider: classifier.name, model: env.CLASSIFIER_MODEL });

  return {
    env,
    logger,
    requests,
    taxonomy,
    classification: new ClassificationService({
      requests,
      taxonomy,
      classifier,
      clock: systemClock,
      logger,
      timeoutMs: env.CLASSIFIER_TIMEOUT_MS,
    }),
    availability: new ExpertAvailabilityService({
      availability: new PrismaExpertAvailabilityRepository(prisma),
      clock: systemClock,
      logger,
      heartbeatStaleAfterSeconds: env.HEARTBEAT_STALE_AFTER_SECONDS,
      heartbeatIntervalSeconds: env.HEARTBEAT_INTERVAL_SECONDS,
    }),
    matching: new MatchingService({
      requests,
      matching: matchingRepo,
      candidates,
      auditLog: new PrismaUnitOfWork(prisma).auditLog,
      scheduler,
      clock: systemClock,
      logger,
      notifier: new DispatchNotifier({
        realtime,
        clock: systemClock,
        logger,
        notifications: new NotificationService({
          notifications: new PrismaNotificationRepository(prisma),
          clock: systemClock,
          logger,
        }),
      }),
      queues: {
        dispatchNextOffer: QUEUES.DISPATCH_NEXT_OFFER,
        offerTimeout: QUEUES.OFFER_TIMEOUT,
        matchingDeadline: QUEUES.MATCHING_DEADLINE,
      },
      thresholds: {
        ...DEFAULT_MATCHING_THRESHOLDS,
        offerWindowSeconds: env.OFFER_WINDOW_SECONDS,
        relaxationScheduleSeconds: env.RELAXATION_SCHEDULE_SECONDS,
        heartbeatStaleAfterSeconds: env.HEARTBEAT_STALE_AFTER_SECONDS,
        offerPresenceGraceSeconds: env.HEARTBEAT_STALE_AFTER_SECONDS,
      },
    }),
  };
}
