import {
  AnthropicProblemClassifier,
  ConsoleLogger,
  InMemoryRateLimiter,
  LocalFileStorage,
  MockPaymentGateway,
  MockPayoutProvider,
  NoopRealtimeBus,
  PgBossScheduler,
  PostgresRealtimeBus,
  PostgresRealtimeHub,
  PrismaAttachmentRepository,
  PrismaCandidateRepository,
  PrismaExpertAvailabilityRepository,
  PrismaExpertPhotoRepository,
  PrismaExpertProfileRepository,
  PrismaExpertSkillRepository,
  PrismaMatchingRepository,
  PrismaNotificationRepository,
  PrismaPricingRepository,
  PrismaSupportLeadRepository,
  PrismaSupportRequestRepository,
  PrismaTaxonomyRepository,
  PrismaUnitOfWork,
  PrismaWebhookEventRepository,
  RulesProblemClassifier,
  SendOnlyBoss,
  StripePaymentGateway,
} from "@sfx/adapters";
import { prisma } from "@sfx/db";
import type { PrismaClient } from "@sfx/db";
import {
  AccountService,
  DEFAULT_MATCHING_THRESHOLDS,
  DispatchNotifier,
  ExpertAdminService,
  ExpertApplicationService,
  ExpertAvailabilityService,
  ExpertPhotoService,
  ExpertProfileService,
  ExpertSkillService,
  MatchingService,
  NotificationService,
  PaymentWebhookService,
  SupportLeadService,
  SupportRequestService,
  systemClock,
  type AttachmentRepository,
  type Clock,
  type JobScheduler,
  type Logger,
  type PaymentGateway,
  type PayoutProvider,
  type PricingRepository,
  type ProblemClassifier,
  type RateLimiter,
  type SupportRequestRepository,
  type TaxonomyRepository,
  type UnitOfWork,
} from "@sfx/domain";
import { join } from "node:path";
import { QUEUES } from "./queues.js";
import { serverEnv } from "./env.js";

/**
 * Composition root — the one module allowed to know about concrete adapters
 * (ARCHITECTURE.md §7). Everything else receives interfaces.
 *
 * Swapping a provider is a change here and nowhere else. That is what lets
 * Phases 1–6 run on mocks while the payment and payout providers stay
 * undecided (§C2, Q3).
 */
export interface Container {
  readonly prisma: PrismaClient;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly uow: UnitOfWork;
  readonly paymentGateway: PaymentGateway;
  readonly payoutProvider: PayoutProvider;
  readonly rateLimiter: RateLimiter;
  readonly storage: LocalFileStorage;
  readonly scheduler: JobScheduler;
  readonly requests: SupportRequestRepository;
  readonly taxonomy: TaxonomyRepository;
  readonly pricing: PricingRepository;
  readonly attachments: AttachmentRepository;
  readonly accounts: AccountService;
  readonly expertApplications: ExpertApplicationService;
  readonly expertAdmin: ExpertAdminService;
  readonly expertAvailability: ExpertAvailabilityService;
  readonly expertSkills: ExpertSkillService;
  readonly expertProfiles: ExpertProfileService;
  /**
   * The web app calls this for expert responses and admin dispatch only. The
   * *loop* — timers, relaxation, re-dispatch — runs in the worker (D2); a
   * serverless handler cannot be trusted to still be executing in 60 seconds.
   */
  readonly matching: MatchingService;
  readonly matchingRepo: PrismaMatchingRepository;
  /** Null when realtime is off — the SSE route then holds the stream open and sends nothing. */
  readonly realtimeHub: PostgresRealtimeHub | null;
  readonly supportRequests: SupportRequestService;
  readonly supportLeads: SupportLeadService;
  readonly notifications: NotificationService;
  readonly expertPhotos: ExpertPhotoService;
  readonly paymentWebhooks: PaymentWebhookService;
  /** Built lazily — it needs the taxonomy, which lives in the database. */
  buildClassifier(): Promise<ProblemClassifier>;
}

let cached: Container | undefined;

function build(): Container {
  const env = serverEnv();
  const logger = new ConsoleLogger(env.LOG_LEVEL, { service: "web" });
  // Built here rather than inline in the returned object because the dispatch
  // notifier needs the same instance.
  const notificationService = new NotificationService({
    notifications: new PrismaNotificationRepository(prisma),
    clock: systemClock,
    logger,
  });
  const clock = systemClock;
  const uow = new PrismaUnitOfWork(prisma);

  const paymentGateway: PaymentGateway = (() => {
    switch (env.PAYMENT_PROVIDER) {
      case "mock":
        return new MockPaymentGateway();
      case "stripe":
        // The env schema has already refused to boot without both credentials,
        // so these are non-null by the time we get here.
        return new StripePaymentGateway({
          secretKey: env.STRIPE_SECRET_KEY ?? "",
          webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? "",
          logger,
        });
      // The exhaustive switch means adding a provider to the enum without an
      // adapter fails typecheck rather than falling through at runtime.
      default: {
        const never: never = env.PAYMENT_PROVIDER;
        throw new Error(`Unsupported PAYMENT_PROVIDER: ${String(never)}`);
      }
    }
  })();

  const payoutProvider: PayoutProvider = (() => {
    switch (env.PAYOUT_PROVIDER) {
      case "mock":
        return new MockPayoutProvider();
      default: {
        const never: never = env.PAYOUT_PROVIDER;
        throw new Error(`Unsupported PAYOUT_PROVIDER: ${String(never)}`);
      }
    }
  })();

  // ⚠️ Per-process. Must be replaced with a shared store before public
  // deployment — see ARCHITECTURE.md → Pre-deployment gates.
  const rateLimiter = new InMemoryRateLimiter();

  const storage = new LocalFileStorage({
    rootDir: join(process.cwd(), ".storage"),
    // Distinct from the auth secret's other uses, so a leaked download URL
    // cannot be replayed as anything else.
    signingSecret: `${env.BETTER_AUTH_SECRET}:storage`,
    baseUrl: env.BETTER_AUTH_URL,
  });

  // Send-only: the web app enqueues work but must never execute it (D2).
  const scheduler = new PgBossScheduler(
    new SendOnlyBoss({
      connectionString: env.DIRECT_DATABASE_URL ?? env.DATABASE_URL,
      logger,
    }),
    logger,
  );

  const requests = new PrismaSupportRequestRepository(prisma);
  const taxonomy = new PrismaTaxonomyRepository(prisma);
  const pricing = new PrismaPricingRepository(prisma);
  const attachments = new PrismaAttachmentRepository(prisma);
  const matchingRepo = new PrismaMatchingRepository(prisma);

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
        throw new Error("REALTIME_PROVIDER=ably has no adapter yet. Use postgres or mock.");
      default: {
        const never: never = env.REALTIME_PROVIDER;
        throw new Error(`Unsupported REALTIME_PROVIDER: ${String(never)}`);
      }
    }
  })();

  // One LISTEN connection for the whole web process, fanned out to every open
  // SSE stream. A connection per subscriber would exhaust the pool at a few
  // dozen experts. Needs the unpooled URL — a transaction pooler cannot hold a
  // LISTEN.
  const realtimeHub =
    env.REALTIME_PROVIDER === "postgres"
      ? new PostgresRealtimeHub(env.DIRECT_DATABASE_URL ?? env.DATABASE_URL, logger)
      : null;

  return {
    prisma,
    clock,
    logger,
    uow,
    paymentGateway,
    payoutProvider,
    rateLimiter,
    storage,
    scheduler,
    requests,
    taxonomy,
    pricing,
    attachments,
    accounts: new AccountService(uow),
    expertApplications: new ExpertApplicationService(uow, clock),
    expertAdmin: new ExpertAdminService(uow, clock),
    expertAvailability: new ExpertAvailabilityService({
      availability: new PrismaExpertAvailabilityRepository(prisma),
      clock,
      logger,
      heartbeatStaleAfterSeconds: env.HEARTBEAT_STALE_AFTER_SECONDS,
      heartbeatIntervalSeconds: env.HEARTBEAT_INTERVAL_SECONDS,
    }),
    expertSkills: new ExpertSkillService({
      skills: new PrismaExpertSkillRepository(prisma),
      taxonomy,
      applications: uow.expertApplications,
      auditLog: uow.auditLog,
      clock,
    }),
    matchingRepo,
    realtimeHub,
    matching: new MatchingService({
      requests,
      matching: matchingRepo,
      candidates: new PrismaCandidateRepository(prisma),
      auditLog: uow.auditLog,
      scheduler,
      clock,
      logger,
      notifier: new DispatchNotifier({
        realtime,
        clock,
        logger,
        notifications: notificationService,
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
    expertProfiles: new ExpertProfileService({
      profiles: new PrismaExpertProfileRepository(prisma),
      applications: uow.expertApplications,
      auditLog: uow.auditLog,
      clock,
    }),

    notifications: notificationService,
    expertPhotos: new ExpertPhotoService({
      photos: new PrismaExpertPhotoRepository(prisma),
      clock,
    }),
    paymentWebhooks: new PaymentWebhookService({
      gateway: paymentGateway,
      events: new PrismaWebhookEventRepository(prisma),
      logger,
    }),
    supportLeads: new SupportLeadService({ leads: new PrismaSupportLeadRepository(prisma) }),
    supportRequests: new SupportRequestService({
      requests,
      taxonomy,
      pricing,
      attachments,
      payments: paymentGateway,
      scheduler,
      clock,
      matchingWindowMinutes: 15,
      classifyQueue: QUEUES.CLASSIFY_REQUEST,
      logger,
    }),
    async buildClassifier() {
      if (env.CLASSIFIER_PROVIDER === "anthropic" && env.ANTHROPIC_API_KEY) {
        return new AnthropicProblemClassifier({
          apiKey: env.ANTHROPIC_API_KEY,
          model: env.CLASSIFIER_MODEL,
          logger,
        });
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
    },
  };
}

export function getContainer(): Container {
  cached ??= build();
  return cached;
}
