/**
 * Idempotent seed. Safe to re-run — everything upserts on a stable slug/key.
 *
 * Seeds three things:
 *   1. The §2 skill taxonomy (categories + skills + aliases).
 *   2. Matching configuration (§13 — weights are data, never hardcoded).
 *   3. Placeholder pricing tiers (Q2 still open; the price snapshot on
 *      SupportRequest means changing these later never rewrites history).
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

type SkillSeed = { slug: string; name: string; aliases?: string[] };
type CategorySeed = { slug: string; name: string; order: number; skills: SkillSeed[] };

const TAXONOMY: CategorySeed[] = [
  {
    slug: "salesforce-development",
    name: "Salesforce Development",
    order: 1,
    skills: [
      { slug: "apex", name: "Apex", aliases: ["apex class", "apex code"] },
      {
        slug: "lwc",
        name: "Lightning Web Components",
        aliases: ["LWC", "lightning web component", "web component"],
      },
      { slug: "aura", name: "Aura Components", aliases: ["aura component", "lightning component"] },
      { slug: "visualforce", name: "Visualforce", aliases: ["VF", "visualforce page"] },
      { slug: "soql-sosl", name: "SOQL / SOSL", aliases: ["SOQL", "SOSL", "query"] },
      { slug: "triggers", name: "Apex Triggers", aliases: ["trigger", "trigger handler"] },
      { slug: "batch-apex", name: "Batch Apex", aliases: ["batchable", "batch job"] },
      { slug: "queueable-apex", name: "Queueable Apex", aliases: ["queueable", "async apex"] },
      { slug: "scheduled-apex", name: "Scheduled Apex", aliases: ["schedulable", "cron apex"] },
      { slug: "platform-events", name: "Platform Events", aliases: ["pub/sub", "event bus"] },
      {
        slug: "apis-integrations",
        name: "APIs & Integrations",
        aliases: ["REST API", "SOAP API", "callout", "named credential", "bulk api"],
      },
      {
        slug: "governor-limits",
        name: "Governor Limits & Performance",
        aliases: ["governor limit", "CPU timeout", "too many SOQL queries", "heap size"],
      },
      { slug: "debugging", name: "Debugging", aliases: ["debug log", "stack trace", "exception"] },
      { slug: "unit-tests", name: "Apex Unit Tests", aliases: ["test class", "code coverage"] },
      {
        slug: "deployment-issues",
        name: "Deployment Issues",
        aliases: ["deployment error", "validation failure", "change set"],
      },
    ],
  },
  {
    slug: "salesforce-configuration",
    name: "Salesforce Configuration",
    order: 2,
    skills: [
      {
        slug: "flow",
        name: "Flow",
        aliases: ["flow builder", "record triggered flow", "screen flow"],
      },
      { slug: "validation-rules", name: "Validation Rules", aliases: ["validation rule"] },
      { slug: "approval-processes", name: "Approval Processes", aliases: ["approval process"] },
      { slug: "security", name: "Security Model", aliases: ["FLS", "field level security", "OWD"] },
      { slug: "profiles", name: "Profiles", aliases: ["profile"] },
      { slug: "permission-sets", name: "Permission Sets", aliases: ["permission set", "permset"] },
      {
        slug: "sharing",
        name: "Sharing Rules",
        aliases: ["sharing rule", "apex sharing", "role hierarchy"],
      },
      { slug: "reports", name: "Reports", aliases: ["report type", "report builder"] },
      { slug: "dashboards", name: "Dashboards", aliases: ["dashboard"] },
      {
        slug: "data-management",
        name: "Data Management",
        aliases: ["data loader", "import", "dedupe"],
      },
    ],
  },
  {
    slug: "salesforce-clouds",
    name: "Salesforce Clouds",
    order: 3,
    skills: [
      { slug: "sales-cloud", name: "Sales Cloud" },
      {
        slug: "service-cloud",
        name: "Service Cloud",
        aliases: ["case management", "omni-channel"],
      },
      {
        slug: "experience-cloud",
        name: "Experience Cloud",
        aliases: ["community", "community cloud"],
      },
      {
        slug: "health-cloud",
        name: "Health Cloud",
        // Technical support is in scope; sharing actual patient data is prohibited (§31).
        aliases: ["health cloud"],
      },
      {
        slug: "revenue-cloud-cpq",
        name: "Revenue Cloud / CPQ",
        aliases: ["CPQ", "steelbrick", "price rule", "quote"],
      },
      { slug: "data-cloud", name: "Data Cloud", aliases: ["CDP", "customer data platform"] },
      { slug: "field-service", name: "Field Service", aliases: ["FSL", "field service lightning"] },
      {
        slug: "marketing-cloud",
        name: "Marketing Cloud",
        aliases: ["SFMC", "journey builder", "AMPscript"],
      },
    ],
  },
  {
    slug: "omnistudio",
    name: "OmniStudio",
    order: 4,
    skills: [
      { slug: "omniscripts", name: "OmniScripts", aliases: ["omniscript"] },
      { slug: "dataraptors", name: "DataRaptors", aliases: ["dataraptor", "data raptor"] },
      {
        slug: "integration-procedures",
        name: "Integration Procedures",
        aliases: ["IP", "integration procedure"],
      },
      { slug: "flexcards", name: "FlexCards", aliases: ["flexcard", "flex card"] },
    ],
  },
  {
    slug: "salesforce-devops",
    name: "Salesforce DevOps",
    order: 5,
    skills: [
      { slug: "git", name: "Git", aliases: ["rebase", "merge conflict", "branch"] },
      { slug: "github", name: "GitHub", aliases: ["pull request", "github actions"] },
      { slug: "salesforce-cli", name: "Salesforce CLI", aliases: ["sfdx", "sf cli"] },
      { slug: "vs-code", name: "VS Code", aliases: ["vscode", "salesforce extensions"] },
      { slug: "copado", name: "Copado", aliases: ["copado deployment", "copado promotion"] },
      { slug: "ci-cd", name: "CI/CD", aliases: ["pipeline", "continuous integration"] },
      {
        slug: "metadata-deployments",
        name: "Metadata Deployments",
        aliases: ["metadata api", "package.xml", "deploy"],
      },
      {
        slug: "branching-merging",
        name: "Branching & Merging",
        aliases: ["merge conflict", "feature branch"],
      },
    ],
  },
  {
    slug: "mulesoft",
    name: "MuleSoft",
    order: 6,
    skills: [
      { slug: "anypoint-studio", name: "Anypoint Studio", aliases: ["anypoint"] },
      { slug: "mule-applications", name: "Mule Applications", aliases: ["mule app", "mule flow"] },
      {
        slug: "mulesoft-sf-connector",
        name: "Salesforce Connector",
        aliases: ["salesforce connector"],
      },
      { slug: "mulesoft-apis", name: "MuleSoft APIs", aliases: ["RAML", "API manager"] },
      { slug: "dataweave", name: "DataWeave", aliases: ["dwl", "data weave"] },
      { slug: "integration-troubleshooting", name: "Integration Troubleshooting" },
    ],
  },
];

/**
 * §5 matching configuration. Lives in the database so it can be tuned without a
 * deploy, and is snapshotted onto every MatchingRun so historical decisions stay
 * explainable after a change (§26).
 */
const MATCHING_WEIGHTS = {
  skill: 0.4,
  rating: 0.2,
  experience: 0.15,
  fairness: 0.15,
  reliability: 0.1,
} as const;

const MATCHING_THRESHOLDS = {
  /// Offer window in seconds (§15).
  offerWindowSeconds: 60,
  /// Total matching window in minutes (§15).
  matchingWindowMinutes: 15,
  /// Max candidates ranked per run.
  candidatePoolSize: 10,
  /// Heartbeat staleness before an expert is swept OFFLINE (§C4).
  /// 3 minutes tolerates browsers throttling background-tab timers to ~1/min.
  heartbeatStaleAfterSeconds: 180,
  heartbeatIntervalSeconds: 45,
  /// Fairness horizon in minutes — idle time at which fairnessScore saturates.
  fairnessHorizonMinutes: 240,
  /// Bayesian shrinkage prior for ratings.
  ratingPriorCount: 5,
  ratingPriorMean: 4.5,
  /// Minimum shrunk rating, waived below `minRatedSessions`.
  minRating: 3.5,
  minRatedSessions: 3,
  /// §C3 — the primary-skill competence floor per relaxation level.
  /// INTERMEDIATE is absolute: no level may go below it. A wrong expert is
  /// worse than no expert, because the promise is that we chose correctly.
  primaryProficiencyFloorByLevel: ["ADVANCED", "ADVANCED", "INTERMEDIATE", "INTERMEDIATE"],
  absolutePrimaryProficiencyFloor: "INTERMEDIATE",
  /// Elapsed SECONDS at which each relaxation level engages (§C3).
  ///
  /// 0 · 90s · 3m · 6m, inside the 15-minute deadline. Tuned for a small launch
  /// roster: a thin bench exhausts its level-0 candidates in seconds, and making
  /// the customer wait four minutes for a level change they cannot see is the
  /// worst possible use of a fifteen-minute promise.
  ///
  /// Overridable by RELAXATION_SCHEDULE_SECONDS. Snapshotted onto every
  /// MatchingRun, so retuning it never rewrites the reasoning behind an old
  /// decision.
  relaxationScheduleSeconds: [0, 90, 180, 360],
  maxRelaxationLevel: 3,
} as const;

const CLASSIFIER_CONFIG = {
  /// §C1 — start cheap, measure, then evaluate. Overridable by CLASSIFIER_MODEL.
  model: "claude-haiku-4-5",
  timeoutMs: 4000,
  maxRetries: 1,
  /// Falling below this over `evaluationWindow` requests raises an evaluation
  /// trigger — NOT an automatic model switch. Promotion requires a comparative
  /// run against the same sample showing material improvement.
  agreementThreshold: 0.85,
  evaluationWindow: 200,
} as const;

async function seedTaxonomy(): Promise<void> {
  for (const category of TAXONOMY) {
    const row = await prisma.category.upsert({
      where: { slug: category.slug },
      update: { name: category.name, displayOrder: category.order, isActive: true },
      create: {
        slug: category.slug,
        name: category.name,
        displayOrder: category.order,
      },
    });

    for (const skill of category.skills) {
      await prisma.skill.upsert({
        where: { slug: skill.slug },
        update: {
          name: skill.name,
          categoryId: row.id,
          aliases: skill.aliases ?? [],
          isActive: true,
        },
        create: {
          slug: skill.slug,
          name: skill.name,
          categoryId: row.id,
          aliases: skill.aliases ?? [],
        },
      });
    }
  }

  const categories = TAXONOMY.length;
  const skills = TAXONOMY.reduce((n, c) => n + c.skills.length, 0);
  console.warn(`  taxonomy: ${categories} categories, ${skills} skills`);
}

async function seedConfiguration(): Promise<void> {
  const entries: Array<{ key: string; value: object }> = [
    { key: "matching.weights", value: MATCHING_WEIGHTS },
    { key: "matching.thresholds", value: MATCHING_THRESHOLDS },
    { key: "classifier", value: CLASSIFIER_CONFIG },
  ];

  for (const entry of entries) {
    await prisma.platformConfiguration.upsert({
      where: { key: entry.key },
      update: { value: entry.value },
      create: { key: entry.key, value: entry.value },
    });
  }
  console.warn(`  configuration: ${entries.length} keys`);
}

async function seedPricing(): Promise<void> {
  // PLACEHOLDER VALUES — Q2 is still open. Deliberately obvious round numbers so
  // nobody mistakes them for a decision. The price snapshot on SupportRequest
  // means changing these later never rewrites historical requests.
  const tiers = [
    { name: "30-minute session", durationMinutes: 30, priceCents: 100000, platformFeeBps: 2500 },
    { name: "60-minute session", durationMinutes: 60, priceCents: 180000, platformFeeBps: 2500 },
  ];

  for (const tier of tiers) {
    const existing = await prisma.pricingTier.findFirst({
      where: { durationMinutes: tier.durationMinutes, currency: "INR" },
    });
    if (existing) {
      await prisma.pricingTier.update({ where: { id: existing.id }, data: tier });
    } else {
      await prisma.pricingTier.create({ data: { ...tier, currency: "INR" } });
    }
  }
  console.warn(`  pricing: ${tiers.length} placeholder tiers (Q2 open)`);
}

async function main(): Promise<void> {
  console.warn("seeding…");
  await seedTaxonomy();
  await seedConfiguration();
  await seedPricing();
  console.warn("seed complete");
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
