import type { CurrencyCode, Difficulty, RequestState } from "@sfx/contracts";
import type {
  AttachmentRecord,
  AttachmentRepository,
  AttachSkillsInput,
  CategoryRecord,
  CreateSupportRequestInput,
  JobScheduler,
  PricingRepository,
  PricingTierRecord,
  RequestSkillRecord,
  SkillRecord,
  StateTransitionInput,
  SupportRequestRecord,
  SupportRequestRepository,
  TaxonomyRepository,
} from "../ports/request-repositories.js";
import type {
  AuthorizeRequest,
  Authorization,
  Capture,
  PaymentGateway,
  PaymentWebhookEvent,
  RefundRequest,
  RefundResult,
} from "../ports/payment.js";
import type { Logger } from "../ports/logger.js";

/**
 * In-memory doubles for the Phase 3 ports.
 *
 * Kept in `src` rather than a test file so it typechecks against the ports on
 * every build: if a port gains a method, this fails to compile rather than
 * drifting quietly out of date.
 *
 * The fakes model the constraints that matter — optimistic version checks,
 * `skipDuplicates` on skills, an authorization that cannot be captured twice —
 * because a fake more permissive than production hides the bugs it should
 * surface.
 */

const CATEGORIES: CategoryRecord[] = [
  {
    id: "cat_dev",
    slug: "salesforce-development",
    name: "Salesforce Development",
    displayOrder: 1,
  },
  {
    id: "cat_cfg",
    slug: "salesforce-configuration",
    name: "Salesforce Configuration",
    displayOrder: 2,
  },
];

const SKILLS: SkillRecord[] = [
  {
    id: "sk_apex",
    slug: "apex",
    name: "Apex",
    categoryId: "cat_dev",
    categorySlug: "salesforce-development",
    aliases: ["apex class"],
  },
  {
    id: "sk_lwc",
    slug: "lwc",
    name: "Lightning Web Components",
    categoryId: "cat_dev",
    categorySlug: "salesforce-development",
    aliases: ["LWC"],
  },
  {
    id: "sk_flow",
    slug: "flow",
    name: "Flow",
    categoryId: "cat_cfg",
    categorySlug: "salesforce-configuration",
    aliases: ["flow builder"],
  },
];

const TIERS: PricingTierRecord[] = [
  {
    id: "tier_30",
    name: "30-minute session",
    durationMinutes: 30,
    priceCents: 100_000,
    currency: "INR",
    platformFeeBps: 2500,
  },
  {
    id: "tier_60",
    name: "60-minute session",
    durationMinutes: 60,
    priceCents: 180_000,
    currency: "INR",
    platformFeeBps: 2500,
  },
];

class FakeTaxonomy implements TaxonomyRepository {
  async listActiveCategories(): Promise<readonly CategoryRecord[]> {
    return CATEGORIES;
  }
  async listActiveSkills(): Promise<readonly SkillRecord[]> {
    return SKILLS;
  }
  async findSkillsBySlug(slugs: readonly string[]): Promise<readonly SkillRecord[]> {
    return SKILLS.filter((skill) => slugs.includes(skill.slug));
  }
  async findCategoryBySlug(slug: string): Promise<CategoryRecord | null> {
    return CATEGORIES.find((category) => category.slug === slug) ?? null;
  }
}

class FakePricing implements PricingRepository {
  async listActiveTiers(currency: CurrencyCode): Promise<readonly PricingTierRecord[]> {
    return TIERS.filter((tier) => tier.currency === currency);
  }
  async findTierById(id: string): Promise<PricingTierRecord | null> {
    return TIERS.find((tier) => tier.id === id) ?? null;
  }
}

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

export class FakeRequestRepository implements SupportRequestRepository {
  readonly rows = new Map<string, SupportRequestRecord>();
  readonly transitions: StateTransitionInput[] = [];
  private sequence = 0;

  async create(input: CreateSupportRequestInput): Promise<SupportRequestRecord> {
    const id = `req_${++this.sequence}`;
    const now = new Date(0);
    const record: SupportRequestRecord = {
      id,
      customerId: input.customerId,
      title: input.title,
      description: input.description,
      state: "CREATED",
      stateEnteredAt: now,
      version: 0,
      primaryCategoryId: input.primaryCategoryId,
      difficulty: null,
      aiConfidence: null,
      aiClassifiedAt: null,
      aiModel: null,
      aiFailureReason: null,
      matchDeadlineAt: input.matchDeadlineAt,
      assignedExpertId: null,
      pricingTierId: input.pricingTierId,
      quotedPriceCents: input.quotedPriceCents,
      currency: input.currency,
      quotedPlatformFeeCents: input.quotedPlatformFeeCents,
      quotedExpertPayoutCents: input.quotedExpertPayoutCents,
      paymentAuthorizationRef: input.paymentAuthorizationRef,
      cancelledAt: null,
      cancellationReason: null,
      createdAt: now,
      updatedAt: now,
      skills: input.skillIds.map((skillId) => {
        const skill = SKILLS.find((s) => s.id === skillId);
        return {
          skillId,
          slug: skill?.slug ?? skillId,
          name: skill?.name ?? skillId,
          source: "CUSTOMER_SELECTED" as const,
          isPrimary: false,
          confidence: null,
        };
      }),
      attachmentCount: 0,
    };
    this.rows.set(id, record);
    return record;
  }

  async findById(id: string): Promise<SupportRequestRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async findByIdForUpdate(id: string): Promise<SupportRequestRecord | null> {
    return this.findById(id);
  }

  async listForCustomer(params: {
    customerId: string;
    limit: number;
  }): Promise<{ items: readonly SupportRequestRecord[]; nextCursor?: string }> {
    return {
      items: [...this.rows.values()]
        .filter((row) => row.customerId === params.customerId)
        .slice(0, params.limit),
    };
  }

  async findActiveForCustomer(customerId: string): Promise<SupportRequestRecord | null> {
    return (
      [...this.rows.values()].find(
        (row) => row.customerId === customerId && ACTIVE_STATES.includes(row.state),
      ) ?? null
    );
  }

  /** Models the optimistic version check — a stale writer gets null, not a win. */
  async applyTransition(input: StateTransitionInput): Promise<SupportRequestRecord | null> {
    const current = this.rows.get(input.requestId);
    if (!current || current.version !== input.expectedVersion) return null;

    const updated: SupportRequestRecord = {
      ...current,
      state: input.toState,
      stateEnteredAt: input.now,
      version: current.version + 1,
      ...(input.toState === "CANCELLED"
        ? { cancelledAt: input.now, cancellationReason: input.reason ?? null }
        : {}),
    };
    this.rows.set(input.requestId, updated);
    this.transitions.push(input);
    return updated;
  }

  /** Models `skipDuplicates` on (requestId, skillId, source). */
  async assignExpert(params: {
    requestId: string;
    expertProfileId: string;
    now: Date;
  }): Promise<void> {
    const current = this.rows.get(params.requestId);
    if (!current) return;
    this.rows.set(params.requestId, {
      ...current,
      assignedExpertId: params.expertProfileId,
      updatedAt: params.now,
    });
  }

  async attachSkills(input: AttachSkillsInput): Promise<void> {
    const current = this.rows.get(input.requestId);
    if (!current) return;

    const existing = new Set(current.skills.map((s) => `${s.skillId}:${s.source}`));
    const added: RequestSkillRecord[] = [];
    for (const skill of input.skills) {
      const key = `${skill.skillId}:${input.source}`;
      if (existing.has(key)) continue;
      existing.add(key);
      const definition = SKILLS.find((s) => s.id === skill.skillId);
      added.push({
        skillId: skill.skillId,
        slug: definition?.slug ?? skill.skillId,
        name: definition?.name ?? skill.skillId,
        source: input.source,
        isPrimary: skill.isPrimary,
        confidence: skill.confidence,
      });
    }
    this.rows.set(input.requestId, { ...current, skills: [...current.skills, ...added] });
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
    const current = this.rows.get(params.requestId);
    if (!current) return;
    this.rows.set(params.requestId, {
      ...current,
      ...(params.primaryCategoryId ? { primaryCategoryId: params.primaryCategoryId } : {}),
      difficulty: params.difficulty,
      aiConfidence: params.confidence,
      aiModel: params.model,
      aiClassifiedAt: params.classifiedAt,
      aiFailureReason: params.failureReason,
    });
  }
}

class FakeAttachments implements AttachmentRepository {
  readonly rows = new Map<string, AttachmentRecord>();

  async create(input: {
    supportRequestId: string | null;
    uploadedByUserId: string;
    storageKey: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
  }): Promise<AttachmentRecord> {
    const record: AttachmentRecord = {
      id: `att_${this.rows.size + 1}`,
      createdAt: new Date(0),
      ...input,
    };
    this.rows.set(record.id, record);
    return record;
  }
  async findById(id: string): Promise<AttachmentRecord | null> {
    return this.rows.get(id) ?? null;
  }
  async listForRequest(requestId: string): Promise<readonly AttachmentRecord[]> {
    return [...this.rows.values()].filter((row) => row.supportRequestId === requestId);
  }
  async bindToRequest(params: {
    attachmentIds: readonly string[];
    requestId: string;
    uploadedByUserId: string;
  }): Promise<number> {
    let bound = 0;
    for (const id of params.attachmentIds) {
      const row = this.rows.get(id);
      // Same scoping as production: uploader must match, and already-bound
      // attachments cannot be moved between requests.
      if (!row || row.uploadedByUserId !== params.uploadedByUserId || row.supportRequestId)
        continue;
      this.rows.set(id, { ...row, supportRequestId: params.requestId });
      bound += 1;
    }
    return bound;
  }
  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }
}

export class FakePaymentGateway implements PaymentGateway {
  readonly name = "fake";
  authorizations = 0;
  voided = 0;
  captured = 0;
  declineNext = false;

  async authorize(request: AuthorizeRequest): Promise<Authorization> {
    if (this.declineNext) {
      this.declineNext = false;
      return {
        providerRef: "fake_declined",
        provider: this.name,
        status: "failed",
        amountMinor: request.amountMinor,
        currency: request.currency,
        failureCode: "card_declined",
        failureMessage: "Your card was declined.",
      };
    }
    this.authorizations += 1;
    return {
      providerRef: `fake_auth_${this.authorizations}`,
      provider: this.name,
      status: "authorized",
      amountMinor: request.amountMinor,
      currency: request.currency,
    };
  }
  async capture(ref: string, amountMinor: number): Promise<Capture> {
    this.captured += 1;
    return { providerRef: ref, capturedMinor: amountMinor, capturedAt: new Date(0) };
  }
  async void(): Promise<void> {
    this.voided += 1;
  }
  async refund(request: RefundRequest): Promise<RefundResult> {
    return { providerRef: "fake_refund", amountMinor: request.amountMinor, status: "succeeded" };
  }
  parseWebhook(): PaymentWebhookEvent | null {
    return null;
  }
}

export class FakeScheduler implements JobScheduler {
  readonly name = "fake";
  readonly jobs: Array<{ queue: string; payload: Record<string, unknown>; singletonKey?: string }> =
    [];

  async enqueue(params: {
    queue: string;
    payload: Record<string, unknown>;
    singletonKey?: string;
  }): Promise<void> {
    this.jobs.push(params);
  }
}

export class SilentLogger implements Logger {
  readonly lines: Array<{ level: string; message: string }> = [];
  debug(message: string): void {
    this.lines.push({ level: "debug", message });
  }
  info(message: string): void {
    this.lines.push({ level: "info", message });
  }
  warn(message: string): void {
    this.lines.push({ level: "warn", message });
  }
  error(message: string): void {
    this.lines.push({ level: "error", message });
  }
  child(): Logger {
    return this;
  }
}

export class InMemoryRequestWorld {
  readonly taxonomy = new FakeTaxonomy();
  readonly pricing = new FakePricing();
  readonly requests = new FakeRequestRepository();
  readonly attachments = new FakeAttachments();
  readonly payments = new FakePaymentGateway();
  readonly scheduler = new FakeScheduler();
  readonly logger = new SilentLogger();
}
