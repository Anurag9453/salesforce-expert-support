import type { CurrencyCode, Difficulty, RequestState, SkillSource } from "@sfx/contracts";
import type { ActorType } from "./repositories.js";

/**
 * Persistence for support requests, the taxonomy, attachments, and pricing.
 *
 * Same rule as the Phase 2 ports: the domain describes what it needs in its own
 * terms and never sees Prisma.
 */

// ── Taxonomy ─────────────────────────────────────────────────────────────────

export interface SkillRecord {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly categoryId: string;
  readonly categorySlug: string;
  readonly aliases: readonly string[];
}

export interface CategoryRecord {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly displayOrder: number;
}

export interface TaxonomyRepository {
  listActiveCategories(): Promise<readonly CategoryRecord[]>;
  listActiveSkills(): Promise<readonly SkillRecord[]>;
  findSkillsBySlug(slugs: readonly string[]): Promise<readonly SkillRecord[]>;
  findCategoryBySlug(slug: string): Promise<CategoryRecord | null>;
}

// ── Pricing ──────────────────────────────────────────────────────────────────

export interface PricingTierRecord {
  readonly id: string;
  readonly name: string;
  readonly durationMinutes: number;
  readonly priceCents: number;
  readonly currency: CurrencyCode;
  readonly platformFeeBps: number;
}

export interface PricingRepository {
  listActiveTiers(currency: CurrencyCode): Promise<readonly PricingTierRecord[]>;
  findTierById(id: string): Promise<PricingTierRecord | null>;
}

// ── Support requests ─────────────────────────────────────────────────────────

export interface RequestSkillRecord {
  readonly skillId: string;
  readonly slug: string;
  readonly name: string;
  readonly source: SkillSource;
  readonly isPrimary: boolean;
  readonly confidence: number | null;
}

export interface SupportRequestRecord {
  readonly id: string;
  readonly customerId: string;
  readonly title: string;
  /** Already redacted (§31). The raw text is never persisted. */
  readonly description: string;
  readonly state: RequestState;
  readonly stateEnteredAt: Date;
  readonly version: number;

  readonly primaryCategoryId: string | null;
  readonly difficulty: Difficulty | null;

  readonly aiConfidence: number | null;
  readonly aiClassifiedAt: Date | null;
  readonly aiModel: string | null;
  readonly aiFailureReason: string | null;

  readonly matchDeadlineAt: Date;
  readonly assignedExpertId: string | null;

  readonly pricingTierId: string;
  readonly quotedPriceCents: number;
  readonly currency: CurrencyCode;
  readonly quotedPlatformFeeCents: number;
  readonly quotedExpertPayoutCents: number;
  readonly paymentAuthorizationRef: string | null;

  readonly cancelledAt: Date | null;
  readonly cancellationReason: string | null;

  readonly createdAt: Date;
  readonly updatedAt: Date;

  readonly skills: readonly RequestSkillRecord[];
  readonly attachmentCount: number;
}

export interface CreateSupportRequestInput {
  readonly customerId: string;
  readonly title: string;
  readonly description: string;
  readonly pricingTierId: string;
  readonly quotedPriceCents: number;
  readonly currency: CurrencyCode;
  readonly quotedPlatformFeeCents: number;
  readonly quotedExpertPayoutCents: number;
  readonly matchDeadlineAt: Date;
  readonly paymentAuthorizationRef: string | null;
  readonly primaryCategoryId: string | null;
  /** Customer-selected skills. Assistive input, never a diagnosis. */
  readonly skillIds: readonly string[];
}

export interface AttachSkillsInput {
  readonly requestId: string;
  readonly source: SkillSource;
  readonly skills: readonly {
    readonly skillId: string;
    readonly isPrimary: boolean;
    readonly confidence: number | null;
  }[];
}

export interface StateTransitionInput {
  readonly requestId: string;
  readonly fromState: RequestState | null;
  readonly toState: RequestState;
  readonly now: Date;
  readonly expectedVersion: number;
  readonly reason?: string | null;
  readonly actorType: ActorType;
  readonly actorUserId?: string | null;
  readonly metadata?: Record<string, unknown>;
}

export interface SupportRequestRepository {
  create(input: CreateSupportRequestInput): Promise<SupportRequestRecord>;
  findById(id: string): Promise<SupportRequestRecord | null>;
  /**
   * Locks the row for the duration of the transaction (`SELECT … FOR UPDATE`).
   * Every state transition reads through this, which is what serialises two
   * workers racing on the same request.
   */
  findByIdForUpdate(id: string): Promise<SupportRequestRecord | null>;
  listForCustomer(params: {
    readonly customerId: string;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<{ readonly items: readonly SupportRequestRecord[]; readonly nextCursor?: string }>;
  /** In-flight request for a customer, if any. At most one at a time in V1. */
  findActiveForCustomer(customerId: string): Promise<SupportRequestRecord | null>;

  /**
   * Applies the transition and writes its history row in one statement pair.
   * Returns null when `expectedVersion` no longer matches, meaning another
   * writer got there first — the caller decides whether that is a conflict or a
   * benign no-op.
   */
  applyTransition(input: StateTransitionInput): Promise<SupportRequestRecord | null>;

  attachSkills(input: AttachSkillsInput): Promise<void>;
  recordClassification(params: {
    readonly requestId: string;
    readonly primaryCategoryId: string | null;
    readonly difficulty: Difficulty | null;
    readonly confidence: number | null;
    readonly model: string | null;
    readonly classifiedAt: Date | null;
    readonly failureReason: string | null;
  }): Promise<void>;
}

// ── Attachments ──────────────────────────────────────────────────────────────

export interface AttachmentRecord {
  readonly id: string;
  readonly supportRequestId: string | null;
  readonly uploadedByUserId: string;
  readonly storageKey: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly createdAt: Date;
}

export interface AttachmentRepository {
  create(input: {
    readonly supportRequestId: string | null;
    readonly uploadedByUserId: string;
    readonly storageKey: string;
    readonly filename: string;
    readonly contentType: string;
    readonly sizeBytes: number;
  }): Promise<AttachmentRecord>;
  findById(id: string): Promise<AttachmentRecord | null>;
  listForRequest(requestId: string): Promise<readonly AttachmentRecord[]>;
  /** Binds orphan uploads to a request once it is created. */
  bindToRequest(params: {
    readonly attachmentIds: readonly string[];
    readonly requestId: string;
    readonly uploadedByUserId: string;
  }): Promise<number>;
  delete(id: string): Promise<void>;
}

/** Enqueues follow-up work inside the same transaction as the state change. */
export interface JobScheduler {
  readonly name: string;
  enqueue(params: {
    readonly queue: string;
    readonly payload: Record<string, unknown>;
    readonly runAfterSeconds?: number;
    /** Collapses duplicate enqueues of the same logical job. */
    readonly singletonKey?: string;
  }): Promise<void>;
}
