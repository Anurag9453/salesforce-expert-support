import type {
  Candidate,
  CandidateSkill,
  RequiredSkill,
  ScoreComponents,
  SkillScoreDetail,
} from "../ports/matching-repositories.js";
import { proficiencyRank, proficiencyValue } from "./proficiency.js";

/**
 * Candidate scoring (§13, requirements 2, 3 and 15).
 *
 * Pure arithmetic over plain data — no clock, no database, no randomness. That
 * is what makes the whole §35 scenario list runnable in milliseconds and what
 * makes "why B and not A" answerable by replaying numbers rather than by
 * reasoning about a model.
 *
 * Requirement 15 taken literally: deterministic weighted scoring plus hard
 * filters. No learned ranking, no embeddings, no solver. The weights are
 * configuration, snapshotted onto every run, so a later tuning cannot rewrite
 * the reasoning behind an old decision.
 */

// ── Inputs ───────────────────────────────────────────────────────────────────
//
// The candidate and score shapes are declared in `ports/matching-repositories`
// and imported here. The ports layer may not import from the domain, so the
// single declaration has to live there; this direction is the allowed one.

export interface ScoringWeights {
  readonly skill: number;
  readonly rating: number;
  readonly experience: number;
  readonly fairness: number;
  readonly reliability: number;
}

export interface ScoringThresholds {
  readonly fairnessHorizonMinutes: number;
  readonly ratingPriorCount: number;
  readonly ratingPriorMean: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  skill: 0.4,
  rating: 0.2,
  experience: 0.15,
  fairness: 0.15,
  reliability: 0.1,
};

export const DEFAULT_SCORING_THRESHOLDS: ScoringThresholds = {
  fairnessHorizonMinutes: 240,
  ratingPriorCount: 5,
  ratingPriorMean: 4.5,
};

// ── Skill ────────────────────────────────────────────────────────────────────

const PRIMARY_WEIGHT = 1;
const SECONDARY_WEIGHT = 0.5;

/**
 * How much the *weakest primary* drags the skill score down.
 *
 * Requirement 2 says primary competence must dominate ranking, not merely gate
 * entry. A plain weighted average does the opposite: enough strong secondaries
 * can paper over a mediocre primary. Reserving 30% of the skill score for the
 * single weakest primary means a candidate cannot buy their way past a weak
 * primary with breadth.
 */
const MIN_PRIMARY_SHARE = 0.3;

export function matchSkill(
  required: RequiredSkill,
  candidateSkills: readonly CandidateSkill[],
  options: {
    readonly allowCategorySubstitute: boolean;
    /**
     * Every skill this request asks for. A substitute must not be one of them:
     * otherwise a single declaration gets counted twice — once as itself and
     * once standing in for something else — which inflates exactly the
     * candidates the floor is meant to hold back.
     */
    readonly allRequiredSkillIds?: readonly string[];
  },
): { readonly skill: CandidateSkill | null; readonly viaCategory: boolean } {
  const direct = candidateSkills.find((skill) => skill.skillId === required.skillId);
  if (direct) return { skill: direct, viaCategory: false };

  // Never for a primary skill. "They know something else in the same category"
  // is exactly the substitution the floor exists to forbid.
  if (!options.allowCategorySubstitute || required.isPrimary) {
    return { skill: null, viaCategory: false };
  }

  const spokenFor = new Set(options.allRequiredSkillIds ?? [required.skillId]);
  const sibling = candidateSkills
    .filter((skill) => skill.categoryId === required.categoryId && !spokenFor.has(skill.skillId))
    .sort(
      (a, b) =>
        proficiencyValue(b.proficiencyLevel, false) - proficiencyValue(a.proficiencyLevel, false),
    )[0];
  return sibling ? { skill: sibling, viaCategory: true } : { skill: null, viaCategory: false };
}

/**
 * The band a request with no primary skill puts everyone in.
 *
 * Above every real proficiency rank, so a request that names no primary skill
 * ranks purely on the weighted score — there is no competence to dominate with.
 */
export const NO_PRIMARY_BAND = 99;

export function scoreSkills(
  required: readonly RequiredSkill[],
  candidate: Candidate,
  options: { readonly allowCategorySubstitute: boolean },
): {
  readonly skillScore: number;
  readonly weightedAverage: number;
  readonly minPrimaryValue: number;
  readonly primaryBand: number;
  readonly perSkill: readonly SkillScoreDetail[];
} {
  const perSkill: SkillScoreDetail[] = [];
  let weightedSum = 0;
  let weightTotal = 0;
  let minPrimaryValue = 1;
  let minPrimaryBand = NO_PRIMARY_BAND;
  let sawPrimary = false;

  const allRequiredSkillIds = required.map((skill) => skill.skillId);

  for (const need of required) {
    const { skill, viaCategory } = matchSkill(need, candidate.skills, {
      ...options,
      allRequiredSkillIds,
    });
    // A skill they simply do not have contributes zero rather than being
    // skipped — otherwise a narrow expert scores the same as a complete one.
    const value = skill ? proficiencyValue(skill.proficiencyLevel, skill.verified) : 0;
    const weight = need.isPrimary ? PRIMARY_WEIGHT : SECONDARY_WEIGHT;

    weightedSum += weight * value;
    weightTotal += weight;

    if (need.isPrimary) {
      sawPrimary = true;
      minPrimaryValue = Math.min(minPrimaryValue, value);
      // The **declared level**, not the verified-adjusted value. Verification
      // must not move a candidate between bands — that would make it mandatory
      // in practice, which requirement 5 forbids. Within a band it still helps,
      // because it raises `value` and therefore the score.
      minPrimaryBand = Math.min(
        minPrimaryBand,
        skill ? proficiencyRank(skill.proficiencyLevel) : -1,
      );
    }

    perSkill.push({
      slug: need.slug,
      isPrimary: need.isPrimary,
      proficiencyLevel: skill?.proficiencyLevel ?? null,
      verified: skill?.verified ?? false,
      value: round(value),
      viaCategory,
    });
  }

  const weightedAverage = weightTotal > 0 ? weightedSum / weightTotal : 0;
  // With no primary skill on the request there is nothing to protect, so the
  // weakest-link term collapses to the average rather than to zero.
  const weakestPrimary = sawPrimary ? minPrimaryValue : weightedAverage;
  const skillScore = (1 - MIN_PRIMARY_SHARE) * weightedAverage + MIN_PRIMARY_SHARE * weakestPrimary;

  return {
    skillScore: round(skillScore),
    weightedAverage: round(weightedAverage),
    minPrimaryValue: round(weakestPrimary),
    primaryBand: sawPrimary ? minPrimaryBand : NO_PRIMARY_BAND,
    perSkill,
  };
}

// ── The other four components ────────────────────────────────────────────────

/**
 * Experience, blending overall tenure with depth in the skills being asked for.
 *
 * Both saturate. Ten years and twenty years are the same answer to "can you
 * handle this in the next hour", and letting tenure keep accumulating would let
 * it substitute for competence — which requirement 2 forbids.
 */
export function scoreExperience(required: readonly RequiredSkill[], candidate: Candidate): number {
  const relevant = candidate.skills.filter((skill) =>
    required.some((need) => need.skillId === skill.skillId),
  );
  const avgSkillYears =
    relevant.length > 0
      ? relevant.reduce((sum, skill) => sum + skill.yearsExperience, 0) / relevant.length
      : 0;

  return round(
    0.6 * Math.min(candidate.yearsExperience / 10, 1) + 0.4 * Math.min(avgSkillYears / 8, 1),
  );
}

/**
 * Bayesian-shrunk rating on a 0–1 scale.
 *
 * One five-star review must not outrank a hundred 4.8s. The prior pulls small
 * samples toward 4.5, so a new expert starts credible-but-unproven rather than
 * either perfect or unrated.
 */
export function shrunkRating(candidate: Candidate, thresholds: ScoringThresholds): number {
  const { ratingPriorCount, ratingPriorMean } = thresholds;
  return (
    (ratingPriorCount * ratingPriorMean + candidate.ratingSum) /
    (ratingPriorCount + candidate.ratingCount)
  );
}

export function scoreRating(candidate: Candidate, thresholds: ScoringThresholds): number {
  return round(shrunkRating(candidate, thresholds) / 5);
}

/**
 * Fairness — spreading work across the bench (requirement 3).
 *
 * Two terms. Idle time rises to 1 over the horizon, so someone who has been
 * waiting all afternoon outranks someone offered work ten minutes ago. Load
 * today discounts it, so an expert already on their sixth session does not keep
 * winning on idle time between them.
 *
 * The weight is what keeps this in its lane: at 0.15 of the total, fairness can
 * reorder near-equals and cannot rescue a materially weaker candidate. That is
 * a property of the weight table, and there is a regression test that asserts
 * it rather than a comment that hopes for it.
 */
export function scoreFairness(candidate: Candidate, thresholds: ScoringThresholds): number {
  // Never offered work at all is maximally idle — a new expert should not be
  // starved by a metric that only starts counting after their first offer.
  const idle = candidate.idleMinutes ?? thresholds.fairnessHorizonMinutes;
  const idleTerm = Math.min(idle / thresholds.fairnessHorizonMinutes, 1);
  const loadDiscount = 1 - 0.3 * Math.min(candidate.sessionsToday / 6, 1);
  return round(idleTerm * loadDiscount);
}

/**
 * Reliability — do they answer, and quickly.
 *
 * Shrunk like the rating, and for the same reason: one accepted offer out of
 * one is not a 100% acceptance rate. Someone with no offers yet sits at the
 * prior rather than at zero.
 */
export function scoreReliability(candidate: Candidate): number {
  const PRIOR_OFFERS = 5;
  const PRIOR_RATE = 0.8;
  const acceptRate =
    (PRIOR_OFFERS * PRIOR_RATE + candidate.offersAccepted) /
    (PRIOR_OFFERS + candidate.offersReceived);

  // Answering in 10 seconds versus 40 is worth something, but far less than
  // answering at all.
  const speedBonus =
    candidate.avgResponseSeconds === null
      ? 0.5
      : Math.max(0, 1 - candidate.avgResponseSeconds / 60);

  return round(0.8 * acceptRate + 0.2 * speedBonus);
}

// ── Composition ──────────────────────────────────────────────────────────────

export function scoreCandidate(params: {
  readonly required: readonly RequiredSkill[];
  readonly candidate: Candidate;
  readonly weights: ScoringWeights;
  readonly thresholds: ScoringThresholds;
  readonly allowCategorySubstitute: boolean;
}): ScoreComponents {
  const { required, candidate, weights, thresholds } = params;

  const skills = scoreSkills(required, candidate, {
    allowCategorySubstitute: params.allowCategorySubstitute,
  });
  const experienceScore = scoreExperience(required, candidate);
  const ratingScore = scoreRating(candidate, thresholds);
  const fairnessScore = scoreFairness(candidate, thresholds);
  const reliabilityScore = scoreReliability(candidate);

  const finalScore =
    weights.skill * skills.skillScore +
    weights.rating * ratingScore +
    weights.experience * experienceScore +
    weights.fairness * fairnessScore +
    weights.reliability * reliabilityScore;

  return {
    skillScore: skills.skillScore,
    experienceScore,
    ratingScore,
    fairnessScore,
    reliabilityScore,
    finalScore: round(finalScore),
    breakdown: {
      weightedAverage: skills.weightedAverage,
      minPrimaryValue: skills.minPrimaryValue,
      primaryBand: skills.primaryBand,
      perSkill: skills.perSkill,
      shrunkRating: round(shrunkRating(candidate, thresholds)),
      acceptanceRate:
        candidate.offersReceived > 0
          ? round(candidate.offersAccepted / candidate.offersReceived)
          : null,
      idleMinutes: candidate.idleMinutes,
      sessionsToday: candidate.sessionsToday,
    },
  };
}

/**
 * Three decimal places, everywhere.
 *
 * Not cosmetic. Rounding at every component makes the score reproducible from
 * the persisted breakdown — an admin reading the stored numbers arrives at
 * exactly the stored total, rather than at something 1e-16 away from it.
 */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Re-exported so callers can import the whole matching vocabulary from one place. */
export type { Candidate, CandidateSkill, RequiredSkill, ScoreComponents, SkillScoreDetail };
