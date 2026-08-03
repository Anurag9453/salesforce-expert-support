import type { ExclusionReason } from "@sfx/contracts";
import type { Candidate, RequiredSkill, ScoreComponents } from "../ports/matching-repositories.js";
import { applyFilters, type CandidateEligibility, type FilterContext } from "./filters.js";
import { ruleForLevel } from "./relaxation.js";
import { scoreCandidate, type ScoringWeights } from "./scoring.js";

/**
 * The matching pipeline (requirement 1).
 *
 * Five stages, kept visibly separate because that separation is what makes the
 * result explainable:
 *
 *   1. eligibility filtering   → filters.ts
 *   2. hard competence filter  → filters.ts
 *   3. scoring and ranking     → scoring.ts, here
 *   4. dispatch                → matching-service.ts
 *   5. controlled relaxation   → relaxation.ts, driven from matching-service.ts
 *
 * This function owns stage 3 and calls stages 1–2. It is pure: same inputs,
 * same ranking, every time. The dispatcher lives elsewhere because it needs a
 * clock, a database and a job queue, and none of those belong in something we
 * want to reason about.
 */

export interface RankingInput {
  readonly required: readonly RequiredSkill[];
  readonly candidates: readonly {
    readonly candidate: Candidate;
    readonly eligibility: CandidateEligibility;
  }[];
  readonly relaxationLevel: number;
  readonly weights: ScoringWeights;
  readonly thresholds: FilterContext["thresholds"];
  readonly customerLanguages: readonly string[];
  readonly now: Date;
  readonly poolSize: number;
  /** Stable tie-break input. The request id, so a re-run orders identically. */
  readonly tieBreakSeed: string;
}

export interface RankedCandidate {
  readonly expertProfileId: string;
  readonly userId: string;
  readonly rank: number;
  readonly score: ScoreComponents;
}

export interface ExcludedCandidate {
  readonly expertProfileId: string;
  readonly userId: string;
  readonly reasons: readonly ExclusionReason[];
  /** No relaxation level will ever admit them to this request. */
  readonly permanent: boolean;
}

export interface RankingResult {
  readonly relaxationLevel: number;
  /** Best first. Truncated to `poolSize`. */
  readonly ranked: readonly RankedCandidate[];
  /** Everyone considered and rejected, with reasons. Never truncated. */
  readonly excluded: readonly ExcludedCandidate[];
  /** How many survived the filters before truncation. */
  readonly eligibleCount: number;
}

export function rankCandidates(input: RankingInput): RankingResult {
  const rule = ruleForLevel(input.relaxationLevel);
  const context: FilterContext = {
    required: input.required,
    rule,
    thresholds: input.thresholds,
    customerLanguages: input.customerLanguages,
    now: input.now,
  };

  const survivors: RankedCandidate[] = [];
  const excluded: ExcludedCandidate[] = [];

  for (const entry of input.candidates) {
    const outcome = applyFilters({
      candidate: entry.candidate,
      eligibility: entry.eligibility,
      context,
    });

    if (!outcome.passed) {
      excluded.push({
        expertProfileId: entry.candidate.expertProfileId,
        userId: entry.candidate.userId,
        reasons: outcome.reasons,
        permanent: outcome.permanent,
      });
      continue;
    }

    survivors.push({
      expertProfileId: entry.candidate.expertProfileId,
      userId: entry.candidate.userId,
      rank: 0, // assigned after sorting
      score: scoreCandidate({
        required: input.required,
        candidate: entry.candidate,
        weights: input.weights,
        thresholds: input.thresholds,
        allowCategorySubstitute: rule.widenSecondaryToCategory,
      }),
    });
  }

  survivors.sort((a, b) => compareCandidates(a, b, input.tieBreakSeed));

  const ranked = survivors
    .slice(0, Math.max(0, input.poolSize))
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));

  return {
    relaxationLevel: rule.level,
    ranked,
    excluded,
    eligibleCount: survivors.length,
  };
}

/**
 * Ordering — **banded**, then scored (requirements 2 and 3).
 *
 * This is the single most consequential decision in the file, and it was made
 * because a test failed rather than because it looked elegant.
 *
 * The obvious design is to rank on `finalScore` alone and set the weights so
 * skill wins. That does not hold. With `skill 0.40` against
 * `rating 0.20 + experience 0.15 + fairness 0.15 + reliability 0.10`, a
 * candidate maxed on every non-technical axis gains about 0.21 while a whole
 * proficiency level of primary skill is worth about 0.13. The regression test in
 * `fairness.test.ts` demonstrated a merely-INTERMEDIATE candidate beating a
 * verified EXPERT. Requirement 2 forbids exactly that, so weights alone cannot
 * be the mechanism — the same lesson as the primary-skill floor, one layer up.
 *
 * So ranking sorts on the **band** first: the ordinal level of the candidate's
 * weakest primary skill. Within a band the weighted score decides everything,
 * which is what keeps requirement 3's first half alive — fairness, rating and
 * verification all still reorder similarly-qualified experts. Across bands
 * nothing can: an ADVANCED candidate never outranks an EXPERT one for that
 * request, however long they have been waiting.
 *
 * "Materially weaker" is therefore defined as *a whole declared level lower*,
 * which is the granularity an expert actually chose on their skills page — and
 * a granularity verification deliberately cannot move them across
 * (requirement 5).
 *
 * After band and score: longer idle time, then a seeded hash of the expert id.
 * The hash matters. Without it, ties resolve by whatever order the database
 * returned rows in, so the "fairest" expert would depend on the query plan. The
 * seed is the request id, so re-ranking the same request at a higher relaxation
 * level breaks ties the same way rather than reshuffling the bench.
 */
function compareCandidates(a: RankedCandidate, b: RankedCandidate, seed: string): number {
  // Requirement 2: primary competence dominates. Nothing below this line can
  // reorder two candidates in different bands.
  if (b.score.breakdown.primaryBand !== a.score.breakdown.primaryBand) {
    return b.score.breakdown.primaryBand - a.score.breakdown.primaryBand;
  }
  if (b.score.finalScore !== a.score.finalScore) {
    return b.score.finalScore - a.score.finalScore;
  }
  if (b.score.breakdown.minPrimaryValue !== a.score.breakdown.minPrimaryValue) {
    return b.score.breakdown.minPrimaryValue - a.score.breakdown.minPrimaryValue;
  }
  const idleA = a.score.breakdown.idleMinutes ?? Number.MAX_SAFE_INTEGER;
  const idleB = b.score.breakdown.idleMinutes ?? Number.MAX_SAFE_INTEGER;
  if (idleB !== idleA) return idleB - idleA;

  return seededHash(seed + a.expertProfileId) - seededHash(seed + b.expertProfileId);
}

/** FNV-1a. Small, fast, and dependency-free — this is a tie-break, not a hash. */
function seededHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
