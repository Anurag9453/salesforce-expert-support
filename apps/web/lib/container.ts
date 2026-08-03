import {
  AnthropicProblemClassifier,
  ConsoleLogger,
  InMemoryRateLimiter,
  LocalFileStorage,
  MockPaymentGateway,
  MockPayoutProvider,
  PgBossScheduler,
  PrismaAttachmentRepository,
  PrismaCandidateRepository,
  PrismaExpertAvailabilityRepository,
  PrismaMatchingRepository,
  PrismaExpertProfileRepository,
  PrismaExpertSkillRepository,
  PrismaPricingRepository,
  PrismaSupportRequestRepository,
  PrismaTaxonomyRepository,
  PrismaUnitOfWork,
  RulesProblemClassifier,
  SendOnlyBoss,
} from "@sfx/adapters";
import { prisma } from "@sfx/db";
import type { PrismaClient } from "@sfx/db";
import {
  AccountService,
  DEFAULT_MATCHING_THRESHOLDS,
  ExpertAdminService,
  ExpertApplicationService,
  ExpertAvailabilityService,
  ExpertProfileService,
  ExpertSkillService,
  MatchingService,
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
  readonly supportRequests: SupportRequestService;
  /** Built lazily — it needs the taxonomy, which lives in the database. */
  buildClassifier(): Promise<ProblemClassifier>;
}

let cached: Container | undefined;

function build(): Container {
  const env = serverEnv();
  const logger = new ConsoleLogger(env.LOG_LEVEL, { service: "web" });
  const clock = systemClock;
  const uow = new PrismaUnitOfWork(prisma);

  const paymentGateway: PaymentGateway = (() => {
    switch (env.PAYMENT_PROVIDER) {
      case "mock":
        return new MockPaymentGateway();
      // Phase 7a adds the real gateway once Q3 resolves. The exhaustive switch
      // means adding a provider to the enum without an adapter fails typecheck.
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
    matching: new MatchingService({
      requests,
      matching: matchingRepo,
      candidates: new PrismaCandidateRepository(prisma),
      auditLog: uow.auditLog,
      scheduler,
      clock,
      logger,
      queues: {
        dispatchNextOffer: QUEUES.DISPATCH_NEXT_OFFER,
        offerTimeout: QUEUES.OFFER_TIMEOUT,
        matchingDeadline: QUEUES.MATCHING_DEADLINE,
      },
      thresholds: {
        ...DEFAULT_MATCHING_THRESHOLDS,
        offerWindowSeconds: env.OFFER_WINDOW_SECONDS,
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
