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
  PrismaPaymentRepository,
  ConsoleMailer,
  MockCrmGateway,
  SalesforceCrmGateway,
  RulesProblemClassifier,
  SendOnlyBoss,
  StripePaymentGateway,
} from "@sfx/adapters";
import { prisma } from "@sfx/db";
import type { PrismaClient } from "@sfx/db";
import {
  AccountService,
  DEFAULT_MATCHING_THRESHOLDS,
  CheckoutService,
  type CrmGateway,
  type Mailer,
  DispatchNotifier,
  ExpertAdminService,
  ExpertApplicationService,
  ExpertAvailabilityService,
  ExpertPhotoService,
  ExpertProfileService,
  ExpertSkillService,
  InterestDispatch,
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
  type SupportRequestRecord,
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
  /**
   * Outbound email. `ConsoleMailer` prints rather than sends, so a production
   * launch needs a real provider here before email verification means anything
   * to anyone outside the team.
   */
  readonly mailer: Mailer;
  readonly paymentGateway: PaymentGateway;
  readonly checkout: CheckoutService;
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
  /** Present always; only *used* when DISPATCH_MODE=interest_pool. */
  readonly interest: InterestDispatch;
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

  /**
   * `mock` is the default so that development, tests and CI never write into a
   * real org. A test suite pointed at Salesforce is one that eventually creates
   * a thousand Leads somebody has to delete.
   */
  const crmGateway: CrmGateway =
    env.CRM_PROVIDER === "salesforce"
      ? new SalesforceCrmGateway({
          // Validated as a set in `env.ts`, so these are present together or the
          // process refused to start.
          instanceUrl: env.SALESFORCE_INSTANCE_URL!,
          clientId: env.SALESFORCE_CLIENT_ID!,
          clientSecret: env.SALESFORCE_CLIENT_SECRET!,
          logger,
        })
      : new MockCrmGateway(logger);

  const mailer: Mailer = new ConsoleMailer(logger);

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

  /**
   * Constructed unconditionally; only *reached* when DISPATCH_MODE says so.
   *
   * MatchingService ignores it under `exclusive`, so building it costs one
   * object and keeps the container free of a conditional whose two branches
   * would need testing separately.
   */
  const interestDispatch = new InterestDispatch({
    matching: matchingRepo,
    scheduler,
    clock,
    logger,
    queues: {
      interestWindowClose: QUEUES.INTEREST_WINDOW_CLOSE,
      confirmationTimeout: QUEUES.CONFIRMATION_TIMEOUT,
    },
    broadcastSize: env.INTEREST_BROADCAST_SIZE,
    interestWindowSeconds: env.INTEREST_WINDOW_SECONDS,
  });

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

  // One notifier, shared. Checkout needs to nudge the customer's screen the
  // moment payment lands, and a second instance would be a second set of
  // swallowed failures to reason about.
  const dispatchNotifier = new DispatchNotifier({
    realtime,
    clock,
    logger,
    notifications: notificationService,
  });

  return {
    prisma,
    clock,
    logger,
    uow,
    mailer,
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
    interest: interestDispatch,
    realtimeHub,
    matching: new MatchingService({
      requests,
      matching: matchingRepo,
      candidates: new PrismaCandidateRepository(prisma),
      auditLog: uow.auditLog,
      scheduler,
      clock,
      logger,
      interest: interestDispatch,
      dispatchMode: env.DISPATCH_MODE,
      notifier: dispatchNotifier,
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
    checkout: new CheckoutService({
      requests,
      payments: new PrismaPaymentRepository(prisma),
      gateway: paymentGateway,
      auditLog: uow.auditLog,
      clock,
      logger,
      // The customer's screen is waiting on this — they are looking at a pay
      // button and expecting a meeting link to replace it.
      onReady: async (request: SupportRequestRecord) => {
        await dispatchNotifier.requestStateChanged(request.id, request.customerId);
      },
    }),
    supportLeads: new SupportLeadService({
      leads: new PrismaSupportLeadRepository(prisma),
      scheduler,
      clock,
      logger,
      crmSyncQueue: QUEUES.CRM_SYNC,
      crm: crmGateway,
    }),
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
      // Decides whether payment is authorized before matching (D1) or after both
      // sides have agreed. See `RequestServiceDeps.dispatchMode`.
      dispatchMode: env.DISPATCH_MODE,
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
