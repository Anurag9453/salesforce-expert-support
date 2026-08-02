import type { Difficulty } from "@sfx/contracts";

/**
 * §8 / §C1 — problem classification.
 *
 * Two properties matter more than accuracy:
 *
 *  1. `classify` returns null rather than throwing, so the fallback to
 *     customer-selected skills is the ordinary path, not an exception path.
 *  2. `allowedSkillSlugs` is passed in per call. The implementation turns it
 *     into a JSON-schema enum, which makes a hallucinated skill structurally
 *     impossible rather than something we validate away afterwards.
 */

export interface ClassificationInput {
  readonly title: string;
  /** Already passed through SecretScanner — never raw customer text (§31). */
  readonly redactedDescription: string;
  /** Closed set from the active Skill table. The model cannot return anything else. */
  readonly allowedSkillSlugs: readonly string[];
  readonly allowedCategorySlugs: readonly string[];
  readonly customerSelectedSkillSlugs: readonly string[];
}

export interface ClassifiedSkill {
  readonly slug: string;
  /**
   * Primary skills gate eligibility (§C3): an expert lacking any primary skill
   * at the competence floor is disqualified, not merely ranked lower.
   */
  readonly isPrimary: boolean;
  readonly confidence: number;
}

export interface ClassificationResult {
  readonly primaryCategorySlug: string;
  readonly skills: readonly ClassifiedSkill[];
  readonly difficulty: Difficulty;
  readonly confidence: number;
  /** Recorded per request so the promotion evaluation compares like for like. */
  readonly model: string;
  readonly latencyMs: number;
}

export interface ProblemClassifier {
  readonly name: string;
  /** Null on failure or timeout. Dispatch never awaits a retry beyond the budget. */
  classify(input: ClassificationInput): Promise<ClassificationResult | null>;
}
