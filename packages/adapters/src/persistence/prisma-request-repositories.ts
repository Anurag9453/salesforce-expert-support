import type { CurrencyCode, Difficulty, RequestState } from "@sfx/contracts";
import type { PrismaClient, PrismaTransactionClient } from "@sfx/db";
import type {
  AttachmentRecord,
  AttachmentRepository,
  AttachSkillsInput,
  CategoryRecord,
  CreateSupportRequestInput,
  PricingRepository,
  PricingTierRecord,
  SkillRecord,
  StateTransitionInput,
  SupportLeadRecord,
  SupportLeadRepository,
  SupportRequestRecord,
  SupportRequestRepository,
  TaxonomyRepository,
} from "@sfx/domain";

type Db = PrismaClient | PrismaTransactionClient;

/** States a customer still has an in-flight request in. */
const ACTIVE_STATES: RequestState[] = [
  "CREATED",
  "CLASSIFYING",
  "SEARCHING",
  "OFFERED",
  "ACCEPTED",
  "PAYMENT_PENDING",
  "READY",
  "IN_SESSION",
];

const REQUEST_INCLUDE = {
  skills: { include: { skill: { select: { slug: true, name: true } } } },
  _count: { select: { attachments: true } },
} as const;

type RequestRow = {
  id: string;
  customerId: string;
  title: string;
  description: string;
  state: RequestState;
  stateEnteredAt: Date;
  version: number;
  primaryCategoryId: string | null;
  difficulty: Difficulty | null;
  aiConfidence: number | null;
  aiClassifiedAt: Date | null;
  aiModel: string | null;
  aiFailureReason: string | null;
  matchDeadlineAt: Date;
  assignedExpertId: string | null;
  pricingTierId: string;
  quotedPriceCents: number;
  currency: string;
  quotedPlatformFeeCents: number;
  quotedExpertPayoutCents: number;
  paymentAuthorizationRef: string | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  skills: Array<{
    skillId: string;
    source: "CUSTOMER_SELECTED" | "AI_DETECTED";
    isPrimary: boolean;
    confidence: number | null;
    skill: { slug: string; name: string };
  }>;
  _count: { attachments: number };
};

function toRequestRecord(row: RequestRow): SupportRequestRecord {
  return {
    id: row.id,
    customerId: row.customerId,
    title: row.title,
    description: row.description,
    state: row.state,
    stateEnteredAt: row.stateEnteredAt,
    version: row.version,
    primaryCategoryId: row.primaryCategoryId,
    difficulty: row.difficulty,
    aiConfidence: row.aiConfidence,
    aiClassifiedAt: row.aiClassifiedAt,
    aiModel: row.aiModel,
    aiFailureReason: row.aiFailureReason,
    matchDeadlineAt: row.matchDeadlineAt,
    assignedExpertId: row.assignedExpertId,
    pricingTierId: row.pricingTierId,
    quotedPriceCents: row.quotedPriceCents,
    currency: row.currency as CurrencyCode,
    quotedPlatformFeeCents: row.quotedPlatformFeeCents,
    quotedExpertPayoutCents: row.quotedExpertPayoutCents,
    paymentAuthorizationRef: row.paymentAuthorizationRef,
    cancelledAt: row.cancelledAt,
    cancellationReason: row.cancellationReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    skills: row.skills.map((link) => ({
      skillId: link.skillId,
      slug: link.skill.slug,
      name: link.skill.name,
      source: link.source,
      isPrimary: link.isPrimary,
      confidence: link.confidence,
    })),
    attachmentCount: row._count.attachments,
  };
}

// ── Taxonomy ─────────────────────────────────────────────────────────────────

export class PrismaTaxonomyRepository implements TaxonomyRepository {
  constructor(private readonly db: Db) {}

  async listActiveCategories(): Promise<readonly CategoryRecord[]> {
    const rows = await this.db.category.findMany({
      where: { isActive: true },
      orderBy: { displayOrder: "asc" },
      select: { id: true, slug: true, name: true, displayOrder: true },
    });
    return rows;
  }

  async listActiveSkills(): Promise<readonly SkillRecord[]> {
    const rows = await this.db.skill.findMany({
      where: { isActive: true, category: { isActive: true } },
      orderBy: { name: "asc" },
      select: {
        id: true,
        slug: true,
        name: true,
        categoryId: true,
        aliases: true,
        category: { select: { slug: true } },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      categoryId: row.categoryId,
      categorySlug: row.category.slug,
      aliases: row.aliases,
    }));
  }

  async findSkillsBySlug(slugs: readonly string[]): Promise<readonly SkillRecord[]> {
    if (slugs.length === 0) return [];
    const rows = await this.db.skill.findMany({
      where: { slug: { in: [...slugs] }, isActive: true },
      select: {
        id: true,
        slug: true,
        name: true,
        categoryId: true,
        aliases: true,
        category: { select: { slug: true } },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      categoryId: row.categoryId,
      categorySlug: row.category.slug,
      aliases: row.aliases,
    }));
  }

  async findCategoryBySlug(slug: string): Promise<CategoryRecord | null> {
    return this.db.category.findUnique({
      where: { slug },
      select: { id: true, slug: true, name: true, displayOrder: true },
    });
  }
}

// ── Pricing ──────────────────────────────────────────────────────────────────

export class PrismaPricingRepository implements PricingRepository {
  constructor(private readonly db: Db) {}

  async listActiveTiers(currency: CurrencyCode): Promise<readonly PricingTierRecord[]> {
    const rows = await this.db.pricingTier.findMany({
      where: { isActive: true, currency },
      orderBy: { durationMinutes: "asc" },
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      durationMinutes: row.durationMinutes,
      priceCents: row.priceCents,
      processingAllowanceCents: row.processingAllowanceCents,
      currency: row.currency as CurrencyCode,
      platformFeeBps: row.platformFeeBps,
    }));
  }

  async findTierById(id: string): Promise<PricingTierRecord | null> {
    const row = await this.db.pricingTier.findUnique({ where: { id } });
    if (!row || !row.isActive) return null;
    return {
      id: row.id,
      name: row.name,
      durationMinutes: row.durationMinutes,
      priceCents: row.priceCents,
      processingAllowanceCents: row.processingAllowanceCents,
      currency: row.currency as CurrencyCode,
      platformFeeBps: row.platformFeeBps,
    };
  }
}

// ── Support requests ─────────────────────────────────────────────────────────

export class PrismaSupportRequestRepository implements SupportRequestRepository {
  constructor(private readonly db: Db) {}

  async create(input: CreateSupportRequestInput): Promise<SupportRequestRecord> {
    const row = await this.db.supportRequest.create({
      data: {
        customerId: input.customerId,
        title: input.title,
        description: input.description,
        pricingTierId: input.pricingTierId,
        quotedPriceCents: input.quotedPriceCents,
        currency: input.currency,
        quotedPlatformFeeCents: input.quotedPlatformFeeCents,
        quotedExpertPayoutCents: input.quotedExpertPayoutCents,
        matchDeadlineAt: input.matchDeadlineAt,
        paymentAuthorizationRef: input.paymentAuthorizationRef,
        primaryCategoryId: input.primaryCategoryId,
        skills: {
          create: input.skillIds.map((skillId) => ({
            skillId,
            source: "CUSTOMER_SELECTED" as const,
            // A customer selection is never primary: primary drives a hard
            // competence filter in Phase 5, and that judgement belongs to the
            // classifier and the description, not to the person with the problem.
            isPrimary: false,
          })),
        },
      },
      include: REQUEST_INCLUDE,
    });
    return toRequestRecord(row as RequestRow);
  }

  async findById(id: string): Promise<SupportRequestRecord | null> {
    const row = await this.db.supportRequest.findUnique({
      where: { id },
      include: REQUEST_INCLUDE,
    });
    return row ? toRequestRecord(row as RequestRow) : null;
  }

  /**
   * Row-level lock for the duration of the transaction.
   *
   * Raw SQL because Prisma has no `FOR UPDATE`. This is what serialises two
   * workers reaching the same request — the second blocks here rather than
   * reading a stale version and losing the optimistic check by luck.
   */
  async findByIdForUpdate(id: string): Promise<SupportRequestRecord | null> {
    const locked = await this.db.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM support_requests WHERE id = ${id} FOR UPDATE
    `;
    if (locked.length === 0) return null;
    return this.findById(id);
  }

  async listForCustomer(params: {
    customerId: string;
    limit: number;
    cursor?: string;
  }): Promise<{ items: readonly SupportRequestRecord[]; nextCursor?: string }> {
    const rows = await this.db.supportRequest.findMany({
      where: { customerId: params.customerId },
      orderBy: { createdAt: "desc" },
      take: params.limit + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
      include: REQUEST_INCLUDE,
    });

    const hasMore = rows.length > params.limit;
    const page = hasMore ? rows.slice(0, params.limit) : rows;
    const nextCursor = hasMore ? page[page.length - 1]?.id : undefined;

    return {
      items: page.map((row) => toRequestRecord(row as RequestRow)),
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
  }

  async findActiveForCustomer(customerId: string): Promise<SupportRequestRecord | null> {
    const row = await this.db.supportRequest.findFirst({
      where: { customerId, state: { in: ACTIVE_STATES } },
      orderBy: { createdAt: "desc" },
      include: REQUEST_INCLUDE,
    });
    return row ? toRequestRecord(row as RequestRow) : null;
  }

  /**
   * Optimistic concurrency plus the history row, atomically.
   *
   * `updateMany` with `version` in the WHERE clause is the guard: if another
   * writer moved first, zero rows match and we return null rather than
   * overwriting their transition (§16 — every transition is validated, and
   * losing a race is not the same as a legal move).
   */
  async applyTransition(input: StateTransitionInput): Promise<SupportRequestRecord | null> {
    const updated = await this.db.supportRequest.updateMany({
      where: { id: input.requestId, version: input.expectedVersion },
      data: {
        state: input.toState,
        stateEnteredAt: input.now,
        version: { increment: 1 },
        ...(input.toState === "CANCELLED"
          ? { cancelledAt: input.now, cancellationReason: input.reason ?? null }
          : {}),
      },
    });

    if (updated.count === 0) return null;

    await this.db.supportRequestStateHistory.create({
      data: {
        supportRequestId: input.requestId,
        fromState: input.fromState,
        toState: input.toState,
        reason: input.reason ?? null,
        actorType: input.actorType,
        actorUserId: input.actorUserId ?? null,
        metadata: (input.metadata ?? {}) as never,
      },
    });

    return this.findById(input.requestId);
  }

  /**
   * Records the accepting expert.
   *
   * Guarded on the row not already having one, so a late duplicate accept
   * cannot reassign a request that is already spoken for. Returns silently
   * either way — the caller's `closeOffer` guard has already decided who won.
   */
  async assignExpert(params: {
    requestId: string;
    expertProfileId: string;
    now: Date;
  }): Promise<void> {
    await this.db.supportRequest.updateMany({
      where: { id: params.requestId, assignedExpertId: null },
      data: { assignedExpertId: params.expertProfileId },
    });
    // Feeds `fairnessScore` and the reliability metrics on the next match.
    await this.db.expertProfile.update({
      where: { id: params.expertProfileId },
      data: { lastAssignedAt: params.now, offersAccepted: { increment: 1 } },
    });
  }

  async attachSkills(input: AttachSkillsInput): Promise<void> {
    if (input.skills.length === 0) return;
    // skipDuplicates makes a redelivered classification job idempotent against
    // the (requestId, skillId, source) unique constraint.
    await this.db.supportRequestSkill.createMany({
      data: input.skills.map((skill) => ({
        supportRequestId: input.requestId,
        skillId: skill.skillId,
        source: input.source,
        isPrimary: skill.isPrimary,
        confidence: skill.confidence,
      })),
      skipDuplicates: true,
    });
  }

  async recordClassification(params: {
    requestId: string;
    primaryCategoryId: string | null;
    difficulty: Difficulty | null;
    confidence: number | null;
    model: string | null;
    classifiedAt: Date | null;
    failureReason: string | null;
  }): Promise<void> {
    await this.db.supportRequest.update({
      where: { id: params.requestId },
      data: {
        // Only overwrite the category when we actually determined one — the
        // customer's own choice must survive a classifier failure.
        ...(params.primaryCategoryId ? { primaryCategoryId: params.primaryCategoryId } : {}),
        difficulty: params.difficulty,
        aiConfidence: params.confidence,
        aiModel: params.model,
        aiClassifiedAt: params.classifiedAt,
        aiFailureReason: params.failureReason,
      },
    });
  }
}

// ── Attachments ──────────────────────────────────────────────────────────────

export class PrismaAttachmentRepository implements AttachmentRepository {
  constructor(private readonly db: Db) {}

  async create(input: {
    supportRequestId: string | null;
    uploadedByUserId: string;
    storageKey: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
  }): Promise<AttachmentRecord> {
    return this.db.attachment.create({ data: input });
  }

  async findById(id: string): Promise<AttachmentRecord | null> {
    return this.db.attachment.findUnique({ where: { id } });
  }

  async listForRequest(requestId: string): Promise<readonly AttachmentRecord[]> {
    return this.db.attachment.findMany({
      where: { supportRequestId: requestId },
      orderBy: { createdAt: "asc" },
    });
  }

  /**
   * Scoped to the uploader AND to still-unbound rows, so an attachment id
   * guessed or leaked from elsewhere cannot be attached to another customer's
   * request, and a bound attachment cannot be moved between requests.
   */
  async bindToRequest(params: {
    attachmentIds: readonly string[];
    requestId: string;
    uploadedByUserId: string;
  }): Promise<number> {
    if (params.attachmentIds.length === 0) return 0;
    const result = await this.db.attachment.updateMany({
      where: {
        id: { in: [...params.attachmentIds] },
        uploadedByUserId: params.uploadedByUserId,
        supportRequestId: null,
      },
      data: { supportRequestId: params.requestId },
    });
    return result.count;
  }

  async delete(id: string): Promise<void> {
    await this.db.attachment.delete({ where: { id } });
  }
}

/** Long-term-support enquiries. See `SupportLeadService` for why it does so little. */
export class PrismaSupportLeadRepository implements SupportLeadRepository {
  constructor(private readonly db: Db) {}

  async create(input: {
    customerId: string | null;
    supportType: "INSTANT" | "SCHEDULED" | "LONG_TERM" | "CERTIFICATION";
    preferredCallAt: Date | null;
    preferredTimezone: string | null;
    certification: string | null;
    certificationExamOn: Date | null;
    certificationHelp: readonly string[];
    title: string | null;
    engagementCount: number | null;
    engagementUnit: "WEEK" | "MONTH" | "YEAR" | null;
    budgetBasis: "HOURLY" | "MONTHLY" | null;
    budgetAmountCents: number | null;
    budgetCurrency: string | null;
    budgetNegotiable: boolean;
    name: string;
    email: string;
    phone: string;
    summary: string;
    durationMinutes: number | null;
    quotedPriceCents: number | null;
    currency: string | null;
  }): Promise<SupportLeadRecord> {
    return toLead(
      await this.db.supportLead.create({
        // Copied rather than passed through: the port declares the list readonly,
        // which is right for a value crossing a boundary, and Prisma's generated
        // input type will not accept one.
        data: { ...input, certificationHelp: [...input.certificationHelp] },
      }),
    );
  }

  async findById(id: string): Promise<SupportLeadRecord | null> {
    const row = await this.db.supportLead.findUnique({ where: { id } });
    return row ? toLead(row) : null;
  }

  async recordCrmOutcome(input: {
    id: string;
    crmRef: string | null;
    syncedAt: Date | null;
    error: string | null;
  }): Promise<void> {
    /*
      A failure must not erase a success.

      There are two things that push a lead to the CRM — the inline attempt when it
      is submitted, and the durable job — and they can run at the same moment. The
      first time both ran together, one created the Salesforce record and the other
      was rejected as a duplicate a fraction of a second apart. Whichever wrote
      last won.

      That is fine when the success lands last and wrong when it does not: an
      unconditional write of `syncedAt: null` would clear the timestamp and the CRM
      reference from a lead that is sitting in Salesforce, and the reconciler would
      then push it again forever.

      So a failure only records itself while the lead is still unsynced. The
      `updateMany` is what makes that atomic — a read-then-write would have the same
      race one layer up.
    */
    if (input.syncedAt === null) {
      await this.db.supportLead.updateMany({
        where: { id: input.id, crmSyncedAt: null },
        data: {
          crmLastError: input.error,
          crmAttempts: { increment: 1 },
        },
      });
      return;
    }

    await this.db.supportLead.update({
      where: { id: input.id },
      data: {
        crmRef: input.crmRef,
        crmSyncedAt: input.syncedAt,
        crmLastError: input.error,
        // Counts every attempt, successful or not. A lead that took six tries to
        // land is worth being able to see afterwards.
        crmAttempts: { increment: 1 },
      },
    });
  }

  async listAwaitingCrm(params: {
    limit: number;
    maxAttempts: number;
  }): Promise<readonly SupportLeadRecord[]> {
    const rows = await this.db.supportLead.findMany({
      where: { crmSyncedAt: null, crmAttempts: { lt: params.maxAttempts } },
      // Oldest first: the enquiry that has been waiting longest is the one most
      // at risk of going cold.
      orderBy: { createdAt: "asc" },
      take: params.limit,
    });
    return rows.map(toLead);
  }
}

type LeadRow = {
  id: string;
  customerId: string | null;
  supportType: "INSTANT" | "SCHEDULED" | "LONG_TERM" | "CERTIFICATION";
  preferredCallAt: Date | null;
  preferredTimezone: string | null;
  certification: string | null;
  certificationExamOn: Date | null;
  certificationHelp: string[];
  title: string | null;
  engagementCount: number | null;
  engagementUnit: "WEEK" | "MONTH" | "YEAR" | null;
  budgetBasis: "HOURLY" | "MONTHLY" | null;
  budgetAmountCents: number | null;
  budgetCurrency: string | null;
  budgetNegotiable: boolean;
  name: string;
  email: string;
  phone: string;
  summary: string;
  durationMinutes: number | null;
  quotedPriceCents: number | null;
  currency: string | null;
  crmRef: string | null;
  crmSyncedAt: Date | null;
  crmAttempts: number;
  crmLastError: string | null;
  createdAt: Date;
};

function toLead(row: LeadRow): SupportLeadRecord {
  return {
    id: row.id,
    customerId: row.customerId,
    supportType: row.supportType,
    preferredCallAt: row.preferredCallAt,
    preferredTimezone: row.preferredTimezone,
    certification: row.certification,
    certificationExamOn: row.certificationExamOn,
    certificationHelp: row.certificationHelp,
    title: row.title,
    engagementCount: row.engagementCount,
    engagementUnit: row.engagementUnit,
    budgetBasis: row.budgetBasis,
    budgetAmountCents: row.budgetAmountCents,
    budgetCurrency: row.budgetCurrency,
    budgetNegotiable: row.budgetNegotiable,
    name: row.name,
    email: row.email,
    phone: row.phone,
    summary: row.summary,
    durationMinutes: row.durationMinutes,
    quotedPriceCents: row.quotedPriceCents,
    currency: row.currency,
    crmRef: row.crmRef,
    crmSyncedAt: row.crmSyncedAt,
    crmAttempts: row.crmAttempts,
    crmLastError: row.crmLastError,
    createdAt: row.createdAt,
  };
}
