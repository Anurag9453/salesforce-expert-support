import type { CurrencyCode } from "@sfx/contracts";
import { authorize, type Actor } from "../authorization/index.js";
import type { Clock } from "../ports/clock.js";
import type { Logger } from "../ports/logger.js";
import { logTiming, TIMING_POINTS } from "../matching/dispatch-events.js";
import type { PaymentGateway } from "../ports/payment.js";
import type {
  AttachmentRepository,
  JobScheduler,
  PricingRepository,
  SupportRequestRecord,
  SupportRequestRepository,
  TaxonomyRepository,
} from "../ports/request-repositories.js";
import { scanForSecrets, type SecretFinding } from "../security/secret-scanner.js";
import { splitFee } from "../shared/money.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import { assertTransition, isTerminal } from "./state-machine.js";

/**
 * Support request creation and lifecycle (§7).
 *
 * Ordering here is the whole point, and it is deliberate:
 *
 *   1. authorize the caller
 *   2. **scan and redact the description** — the raw text is never persisted
 *   3. price the request from an active tier (never from client input)
 *   4. authorize the payment (D1: before matching, so an expert who accepts is
 *      never left waiting on a card)
 *   5. persist, attach customer-selected skills, transition to CLASSIFYING
 *   6. enqueue classification *inside the transaction*
 *
 * Step 2 before step 5 is requirement 6: nothing downstream — storage, the
 * classifier, an expert's screen — ever sees the unredacted text.
 */

export interface CreateRequestInput {
  /** Optional. Derived from the description when absent — see `deriveTitle`. */
  readonly title?: string;
  readonly description: string;
  /**
   * Assistive only (requirement 2). The customer is describing symptoms, not
   * diagnosing; an empty list is entirely normal and costs them nothing.
   */
  readonly skillSlugs?: readonly string[];
  readonly categorySlug?: string;
  readonly pricingTierId: string;
  /** Uploaded ahead of submission, bound to the request here. */
  readonly attachmentIds?: readonly string[];
}

export interface CreateRequestResult {
  readonly request: SupportRequestRecord;
  /**
   * Surfaced so the UI can tell the customer what was removed. Calm and
   * specific, never accusatory (requirement 5).
   */
  readonly secretFindings: readonly SecretFinding[];
}

export interface RequestServiceDeps {
  readonly requests: SupportRequestRepository;
  readonly taxonomy: TaxonomyRepository;
  readonly pricing: PricingRepository;
  readonly attachments: AttachmentRepository;
  readonly payments: PaymentGateway;
  readonly scheduler: JobScheduler;
  readonly clock: Clock;
  readonly matchingWindowMinutes: number;
  readonly classifyQueue: string;
  /** Optional. Only used to record the first of requirement 16's timing points. */
  readonly logger?: Logger;
}

/** Title from the first sentence, so the customer never has to write one. */
export function deriveTitle(description: string): string {
  const firstLine = description.trim().split("\n")[0] ?? "";
  const sentence = firstLine.split(/(?<=[.?!])\s/)[0] ?? firstLine;
  const trimmed = sentence.trim().replace(/[.?!]+$/, "");
  if (trimmed.length === 0) return "Salesforce support request";
  return trimmed.length <= 120 ? trimmed : `${trimmed.slice(0, 117).trimEnd()}…`;
}

export class SupportRequestService {
  constructor(private readonly deps: RequestServiceDeps) {}

  async create(actor: Actor, input: CreateRequestInput): Promise<CreateRequestResult> {
    authorize(actor, "support_request:create");
    const now = this.deps.clock.now();

    if (input.description.trim().length < 20) {
      throw new ValidationError("Tell us a little more about the problem.", {
        description: ["Please describe the problem in at least a sentence or two."],
      });
    }

    const customerId = this.requireCustomerId(actor);

    // One in-flight request at a time. Two live requests would compete for the
    // same experts and double-charge a customer who double-submitted.
    const active = await this.deps.requests.findActiveForCustomer(customerId);
    if (active) {
      throw new ConflictError(
        "You already have a request in progress. Cancel it or wait for it to finish before starting another.",
        { activeRequestId: active.id },
      );
    }

    // ── Requirement 6: redact BEFORE anything is stored or enqueued ──────────
    const scan = scanForSecrets(input.description);
    const titleScan = scanForSecrets(input.title?.trim() || deriveTitle(scan.redacted));

    // ── Price from the server's own tier, never from the request body ────────
    const tier = await this.deps.pricing.findTierById(input.pricingTierId);
    if (!tier) throw new NotFoundError("PricingTier", input.pricingTierId);
    const { platformFee, expertPayout } = splitFee(
      { amountMinor: tier.priceCents, currency: tier.currency },
      tier.platformFeeBps,
    );

    // ── Resolve assistive selections; unknown slugs are ignored, not fatal ───
    const selectedSkills =
      input.skillSlugs && input.skillSlugs.length > 0
        ? await this.deps.taxonomy.findSkillsBySlug(input.skillSlugs)
        : [];
    const category = input.categorySlug
      ? await this.deps.taxonomy.findCategoryBySlug(input.categorySlug)
      : null;

    // ── D1: authorize payment before matching ───────────────────────────────
    const authorization = await this.deps.payments.authorize({
      idempotencyKey: `req:${customerId}:${now.getTime()}`,
      amountMinor: tier.priceCents,
      currency: tier.currency,
      customerRef: null,
      description: `${tier.durationMinutes}-minute Salesforce expert session`,
      metadata: { customerId },
    });
    if (authorization.status === "failed") {
      throw new ValidationError(
        authorization.failureMessage ?? "We could not authorize your payment method.",
        { payment: [authorization.failureCode ?? "authorization_failed"] },
      );
    }

    const created = await this.deps.requests.create({
      customerId,
      title: titleScan.redacted,
      description: scan.redacted,
      pricingTierId: tier.id,
      quotedPriceCents: tier.priceCents,
      currency: tier.currency,
      quotedPlatformFeeCents: platformFee.amountMinor,
      quotedExpertPayoutCents: expertPayout.amountMinor,
      matchDeadlineAt: new Date(now.getTime() + this.deps.matchingWindowMinutes * 60_000),
      paymentAuthorizationRef: authorization.providerRef,
      primaryCategoryId: category?.id ?? null,
      skillIds: selectedSkills.map((skill) => skill.id),
    });

    if (input.attachmentIds && input.attachmentIds.length > 0) {
      // Scoped to this uploader, so an attachment id guessed from elsewhere
      // cannot be attached to someone else's request.
      await this.deps.attachments.bindToRequest({
        attachmentIds: input.attachmentIds,
        requestId: created.id,
        uploadedByUserId: actor.userId,
      });
    }

    const moved = await this.transition(created, "CLASSIFYING", {
      actorType: "SYSTEM",
      reason: "queued for classification",
    });

    // Enqueued after the transition committed, keyed so a retry cannot produce
    // two classification jobs for one request.
    await this.deps.scheduler.enqueue({
      queue: this.deps.classifyQueue,
      payload: { supportRequestId: created.id },
      singletonKey: `classify:${created.id}`,
    });

    // Requirement 16, point 1. Everything downstream measures from here, so it
    // is recorded at the moment the customer's request became durable rather
    // than when a later stage happened to notice it.
    if (this.deps.logger) {
      logTiming(this.deps.logger, TIMING_POINTS.REQUEST_SUBMITTED, {
        supportRequestId: created.id,
        submittedAt: created.createdAt.toISOString(),
        skillsSelected: input.skillSlugs?.length ?? 0,
        attachments: input.attachmentIds?.length ?? 0,
      });
    }

    return {
      request: moved,
      secretFindings: [...scan.findings, ...titleScan.findings],
    };
  }

  async getForCustomer(actor: Actor, requestId: string): Promise<SupportRequestRecord> {
    authorize(actor, "support_request:read_own");
    const request = await this.deps.requests.findById(requestId);
    if (!request) throw new NotFoundError("SupportRequest", requestId);
    // Ownership re-checked against the row we actually read, not against the URL.
    if (request.customerId !== this.requireCustomerId(actor)) {
      throw new ForbiddenError("read", `SupportRequest:${requestId}`);
    }
    return request;
  }

  async listForCustomer(
    actor: Actor,
    params: { limit?: number; cursor?: string } = {},
  ): Promise<{ items: readonly SupportRequestRecord[]; nextCursor?: string }> {
    authorize(actor, "support_request:read_own");
    return this.deps.requests.listForCustomer({
      customerId: this.requireCustomerId(actor),
      limit: Math.min(params.limit ?? 20, 100),
      ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
    });
  }

  async findActive(actor: Actor): Promise<SupportRequestRecord | null> {
    authorize(actor, "support_request:read_own");
    return this.deps.requests.findActiveForCustomer(this.requireCustomerId(actor));
  }

  /**
   * Customer cancellation. Legal only before an expert has committed, and it
   * voids the payment authorization rather than leaving a hold on the card.
   */
  async cancel(actor: Actor, requestId: string, reason?: string): Promise<SupportRequestRecord> {
    authorize(actor, "support_request:cancel_own");
    const request = await this.getForCustomer(actor, requestId);

    if (isTerminal(request.state)) {
      throw new ConflictError(`This request is already ${request.state.toLowerCase()}.`);
    }

    const cancelled = await this.transition(request, "CANCELLED", {
      actorType: "CUSTOMER",
      actorUserId: actor.userId,
      reason: reason ?? "cancelled by customer",
    });

    if (request.paymentAuthorizationRef) {
      // Best effort: the request is already cancelled from the customer's point
      // of view, and a stuck hold is a reconciliation problem rather than a
      // reason to fail their cancellation.
      try {
        await this.deps.payments.void(request.paymentAuthorizationRef, `void:${request.id}`);
      } catch {
        // Phase 7a adds a reconciliation job for exactly this case.
      }
    }

    return cancelled;
  }

  /**
   * The only path that writes `SupportRequest.state` from this service.
   * Validates against the §16 table, then applies with optimistic concurrency.
   */
  private async transition(
    request: SupportRequestRecord,
    to: Parameters<typeof assertTransition>[1],
    options: {
      actorType: "SYSTEM" | "CUSTOMER" | "EXPERT" | "ADMIN";
      actorUserId?: string;
      reason?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<SupportRequestRecord> {
    assertTransition(request.state, to, options.actorType);

    const updated = await this.deps.requests.applyTransition({
      requestId: request.id,
      fromState: request.state,
      toState: to,
      now: this.deps.clock.now(),
      expectedVersion: request.version,
      actorType: options.actorType,
      actorUserId: options.actorUserId ?? null,
      reason: options.reason ?? null,
      ...(options.metadata ? { metadata: options.metadata } : {}),
    });

    if (!updated) {
      throw new ConflictError(
        "This request changed while you were working on it. Reload and try again.",
        { requestId: request.id, expectedVersion: request.version },
      );
    }
    return updated;
  }

  private requireCustomerId(actor: Actor): string {
    if (!actor.customerProfileId) {
      throw new ForbiddenError("act as a customer", `user:${actor.userId}`);
    }
    return actor.customerProfileId;
  }
}

/** Cheapest active tier, used as the default so the customer picks nothing. */
export function defaultTier<T extends { priceCents: number }>(tiers: readonly T[]): T | undefined {
  return [...tiers].sort((a, b) => a.priceCents - b.priceCents)[0];
}

export type { CurrencyCode };
