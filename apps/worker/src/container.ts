import {
  AnthropicProblemClassifier,
  ConsoleLogger,
  PrismaExpertAvailabilityRepository,
  PrismaPricingRepository,
  PrismaSupportRequestRepository,
  PrismaTaxonomyRepository,
  RulesProblemClassifier,
} from "@sfx/adapters";
import { parseServerEnv, type ServerEnv } from "@sfx/contracts";
import { prisma } from "@sfx/db";
import {
  ClassificationService,
  ExpertAvailabilityService,
  systemClock,
  type Logger,
  type ProblemClassifier,
  type SupportRequestRepository,
  type TaxonomyRepository,
} from "@sfx/domain";

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

export async function buildWorkerContainer(): Promise<WorkerContainer> {
  const env = parseServerEnv();
  const logger = new ConsoleLogger(env.LOG_LEVEL, { service: "worker" });

  const requests = new PrismaSupportRequestRepository(prisma);
  const taxonomy = new PrismaTaxonomyRepository(prisma);
  void new PrismaPricingRepository(prisma);

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
  };
}
