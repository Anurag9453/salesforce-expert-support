import type { Difficulty } from "@sfx/contracts";
import type { ProblemClassifier } from "../ports/classifier.js";
import type { Clock } from "../ports/clock.js";
import type { Logger } from "../ports/logger.js";
import type {
  SupportRequestRecord,
  SupportRequestRepository,
  TaxonomyRepository,
} from "../ports/request-repositories.js";
import { scanForSecrets } from "../security/secret-scanner.js";
import { NotFoundError } from "../shared/errors.js";
import { assertTransition } from "../support-requests/state-machine.js";

/**
 * §8 — classify the problem, then move the request to SEARCHING.
 *
 * The load-bearing property is that **this can fail and the product still
 * works** (requirement 4). Every failure path — timeout, provider outage, a
 * model returning nonsense, no API key at all — ends in the same place: the
 * request reaches SEARCHING with whatever the customer selected, and the reason
 * is recorded on the row for later analysis.
 *
 * Classification is an accelerator, never a gate. A customer who selected
 * nothing and hit a classifier outage still gets matched; the matching engine
 * simply has less to work with.
 */

export interface ClassificationDeps {
  readonly requests: SupportRequestRepository;
  readonly taxonomy: TaxonomyRepository;
  readonly classifier: ProblemClassifier;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly timeoutMs: number;
}

export interface ClassificationOutcome {
  readonly request: SupportRequestRecord;
  readonly classified: boolean;
  readonly failureReason: string | null;
  readonly skillsAttached: number;
}

export class ClassificationService {
  constructor(private readonly deps: ClassificationDeps) {}

  /**
   * Called by the worker. Idempotent: a request already past CLASSIFYING is
   * returned untouched, so a redelivered job cannot re-run a classification or
   * re-attempt a transition.
   */
  async classify(supportRequestId: string): Promise<ClassificationOutcome> {
    const request = await this.deps.requests.findById(supportRequestId);
    if (!request) throw new NotFoundError("SupportRequest", supportRequestId);

    if (request.state !== "CLASSIFYING") {
      this.deps.logger.info("classification skipped, request has moved on", {
        supportRequestId,
        state: request.state,
      });
      return { request, classified: false, failureReason: null, skillsAttached: 0 };
    }

    const result = await this.runClassifier(request);

    if (result.ok) {
      await this.deps.requests.recordClassification({
        requestId: request.id,
        primaryCategoryId: result.categoryId,
        difficulty: result.difficulty,
        confidence: result.confidence,
        model: result.model,
        classifiedAt: this.deps.clock.now(),
        failureReason: null,
      });

      if (result.skills.length > 0) {
        // Stored alongside — never replacing — the customer's own selections
        // (§8). Keeping both is what lets us measure the classifier against
        // real customer input later.
        await this.deps.requests.attachSkills({
          requestId: request.id,
          source: "AI_DETECTED",
          skills: result.skills,
        });
      }
    } else {
      await this.deps.requests.recordClassification({
        requestId: request.id,
        primaryCategoryId: null,
        difficulty: null,
        confidence: null,
        model: null,
        classifiedAt: null,
        failureReason: result.reason,
      });
      this.deps.logger.warn("classification failed, falling back to customer selection", {
        supportRequestId,
        reason: result.reason,
        customerSelectedSkills: request.skills.filter((s) => s.source === "CUSTOMER_SELECTED")
          .length,
      });
    }

    // Reached on both paths. This is the guarantee.
    const moved = await this.advanceToSearching(request, result.ok ? null : result.reason);

    return {
      request: moved,
      classified: result.ok,
      failureReason: result.ok ? null : result.reason,
      skillsAttached: result.ok ? result.skills.length : 0,
    };
  }

  private async runClassifier(request: SupportRequestRecord): Promise<
    | {
        ok: true;
        categoryId: string | null;
        difficulty: Difficulty;
        confidence: number;
        model: string;
        skills: { skillId: string; isPrimary: boolean; confidence: number | null }[];
      }
    | { ok: false; reason: string }
  > {
    try {
      const [skills, categories] = await Promise.all([
        this.deps.taxonomy.listActiveSkills(),
        this.deps.taxonomy.listActiveCategories(),
      ]);

      // Belt and braces on requirement 6. The description was redacted before it
      // was ever stored, so this is a second pass over already-clean text —
      // cheap, and it means a future code path that stores raw text cannot
      // silently start leaking through the classifier.
      const safeTitle = scanForSecrets(request.title).redacted;
      const safeDescription = scanForSecrets(request.description).redacted;

      const outcome = await this.withTimeout(
        this.deps.classifier.classify({
          title: safeTitle,
          redactedDescription: safeDescription,
          allowedSkillSlugs: skills.map((s) => s.slug),
          allowedCategorySlugs: categories.map((c) => c.slug),
          customerSelectedSkillSlugs: request.skills
            .filter((s) => s.source === "CUSTOMER_SELECTED")
            .map((s) => s.slug),
        }),
        this.deps.timeoutMs,
      );

      if (!outcome) return { ok: false, reason: "classifier_returned_null_or_timed_out" };

      const bySlug = new Map(skills.map((skill) => [skill.slug, skill]));
      const category = categories.find((c) => c.slug === outcome.primaryCategorySlug) ?? null;

      // Unknown slugs are dropped rather than trusted. The schema makes them
      // structurally impossible, so this is the belt to that braces.
      const resolved = outcome.skills
        .map((skill) => {
          const match = bySlug.get(skill.slug);
          if (!match) return null;
          return {
            skillId: match.id,
            isPrimary: skill.isPrimary,
            confidence: skill.confidence,
          };
        })
        .filter((s): s is NonNullable<typeof s> => s !== null);

      return {
        ok: true,
        categoryId: category?.id ?? null,
        difficulty: outcome.difficulty,
        confidence: outcome.confidence,
        model: outcome.model,
        skills: resolved,
      };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? `classifier_error: ${error.message}` : "classifier_error",
      };
    }
  }

  /** Races the classifier against its budget. Never lets dispatch wait longer. */
  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async advanceToSearching(
    request: SupportRequestRecord,
    failureReason: string | null,
  ): Promise<SupportRequestRecord> {
    assertTransition(request.state, "SEARCHING", "SYSTEM");

    const updated = await this.deps.requests.applyTransition({
      requestId: request.id,
      fromState: request.state,
      toState: "SEARCHING",
      now: this.deps.clock.now(),
      expectedVersion: request.version,
      actorType: "SYSTEM",
      reason: failureReason
        ? "classification failed; using customer-selected skills"
        : "classified",
      metadata: failureReason ? { failureReason } : {},
    });

    if (!updated) {
      // Another worker got there first. Not an error: the request is in
      // SEARCHING either way, which is all this job promised to achieve.
      const current = await this.deps.requests.findById(request.id);
      if (!current) throw new NotFoundError("SupportRequest", request.id);
      return current;
    }
    return updated;
  }
}
