import type { AvailabilityStatus, ExclusionReason, ExpertStatus } from "@sfx/contracts";
import { evaluateEligibility, isHeartbeatFresh } from "../experts/availability.js";
import type { Candidate, RequiredSkill } from "../ports/matching-repositories.js";
import { meetsFloor } from "./proficiency.js";
import { ABSOLUTE_PRIMARY_FLOOR, type RelaxationRule } from "./relaxation.js";
import { matchSkill, shrunkRating, type ScoringThresholds } from "./scoring.js";

/**
 * Stage 1 and stage 2 of matching: eligibility, then hard competence
 * (requirement 1's separate stages, requirements 2 and 11).
 *
 * These are **filters, not penalties**. An expert who fails one does not appear
 * in the ranking at a discount — they do not appear at all. That distinction is
 * the whole of the Copado case: a brilliant generalist with BEGINNER Copado
 * must never be reachable by a Copado question, no matter how much rating,
 * tenure and idle time they bring.
 *
 * Every rejection produces a **reason code**, and every failing reason is
 * collected rather than short-circuiting on the first. Requirement 4 asks the
 * audit trail to answer "why B and not A"; an answer that names one problem
 * when there were three is a misleading answer.
 */

/**
 * Reasons that no amount of relaxation can clear.
 *
 * Used to say something true rather than merely accurate: an expert below the
 * absolute floor is not "not yet eligible", they are out for this request
 * permanently, and no one should wait for them.
 */
export const PERMANENT_FOR_THIS_REQUEST: readonly ExclusionReason[] = [
  "MISSING_PRIMARY_SKILL",
  "ALREADY_RESPONDED",
  "IS_THE_CUSTOMER",
];

export const EXCLUSION_COPY: Record<ExclusionReason, string> = {
  NOT_APPROVED: "Not an approved expert.",
  ACCOUNT_NOT_ACTIVE: "Account is not active.",
  NOT_AVAILABLE: "Set to offline.",
  PRESENCE_STALE: "No recent heartbeat — presence has gone stale.",
  ALREADY_ON_OFFER: "Already holds an open offer.",
  IN_SESSION: "Currently in a session.",
  MISSING_PRIMARY_SKILL: "Has not declared a primary skill this request needs.",
  PRIMARY_BELOW_FLOOR: "Primary-skill proficiency is below the competence floor.",
  // Retained in the vocabulary but unreachable while `secondaryCoverage` is 0 at
  // every level. Kept because historical `MatchingAttempt` rows still carry it and
  // the admin audit has to be able to render them.
  INSUFFICIENT_SECONDARY_COVERAGE: "Covers too few of the secondary skills.",
  RATING_BELOW_FLOOR: "Rating is below the minimum for this relaxation level.",
  NO_LANGUAGE_OVERLAP: "No language in common with the customer.",
  ALREADY_RESPONDED: "Already declined or timed out on this request.",
  IS_THE_CUSTOMER: "Is the customer who raised this request.",
};

export interface CandidateEligibility {
  readonly expertStatus: ExpertStatus;
  readonly accountStatus: "ACTIVE" | "SUSPENDED" | "DELETED";
  readonly availabilityStatus: AvailabilityStatus;
  readonly lastHeartbeatAt: Date | null;
  /** Set when this expert already declined or timed out on this request. */
  readonly alreadyResponded: boolean;
  /** Guards the case of an expert raising a request on their own account. */
  readonly isRequestingCustomer: boolean;
}

export interface FilterContext {
  readonly required: readonly RequiredSkill[];
  readonly rule: RelaxationRule;
  readonly thresholds: ScoringThresholds & {
    readonly minRating: number;
    readonly minRatedSessions: number;
    readonly heartbeatStaleAfterSeconds: number;
  };
  readonly customerLanguages: readonly string[];
  readonly now: Date;
}

export interface FilterOutcome {
  readonly passed: boolean;
  readonly reasons: readonly ExclusionReason[];
  /** True when nothing about time or relaxation could ever change the answer. */
  readonly permanent: boolean;
}

/**
 * Stage 1 — is this expert available to be offered anything at all?
 *
 * Delegates to the same `evaluateEligibility` the expert's own dashboard shows
 * them. That is deliberate: the words an expert reads on their dashboard and
 * the words in the matching audit row come from one function, so "you are not
 * receiving requests because your presence went stale" and the operator's view
 * of why they were skipped cannot disagree.
 */
export function filterEligibility(
  eligibility: CandidateEligibility,
  context: FilterContext,
): readonly ExclusionReason[] {
  const reasons: ExclusionReason[] = [];

  if (eligibility.isRequestingCustomer) reasons.push("IS_THE_CUSTOMER");
  if (eligibility.alreadyResponded) reasons.push("ALREADY_RESPONDED");

  const verdict = evaluateEligibility({
    expertStatus: eligibility.expertStatus,
    accountStatus: eligibility.accountStatus,
    availabilityStatus: eligibility.availabilityStatus,
    lastHeartbeatAt: eligibility.lastHeartbeatAt,
    now: context.now,
    heartbeatStaleAfterSeconds: context.thresholds.heartbeatStaleAfterSeconds,
  });

  for (const reason of verdict.reasons) {
    // NO_MATCHING_SKILLS is the availability module's placeholder for exactly
    // the work this file does; competence is decided below, not there.
    if (reason === "NO_MATCHING_SKILLS") continue;
    reasons.push(reason);
  }

  return reasons;
}

/**
 * Stage 2 — hard competence (§C3, requirement 2).
 *
 * The primary-skill floor is checked here and nowhere else. Two ways to fail
 * it, kept as separate reasons because they mean different things to an
 * operator: `MISSING_PRIMARY_SKILL` is "they have never claimed this",
 * `PRIMARY_BELOW_FLOOR` is "they claimed it and are not deep enough yet".
 */
export function filterCompetence(
  candidate: Candidate,
  context: FilterContext,
): readonly ExclusionReason[] {
  const reasons: ExclusionReason[] = [];
  const { rule, required } = context;

  const primaries = required.filter((skill) => skill.isPrimary);
  let missingPrimary = false;
  let belowFloor = false;

  for (const need of primaries) {
    // Category substitution is never offered for a primary skill, whatever the
    // relaxation level says — see `matchSkill`.
    const { skill } = matchSkill(need, candidate.skills, { allowCategorySubstitute: false });
    if (!skill) {
      missingPrimary = true;
      continue;
    }
    if (!meetsFloor(skill.proficiencyLevel, rule.primaryFloor)) belowFloor = true;
  }

  if (missingPrimary) reasons.push("MISSING_PRIMARY_SKILL");
  if (belowFloor) reasons.push("PRIMARY_BELOW_FLOOR");

  // Secondary-skill coverage.
  //
  // `secondaryCoverage` is 0 at every level, so this never excludes anyone today
  // — secondary alignment is a *ranking* signal carried by `skillScore`, not an
  // eligibility one. The branch is retained rather than deleted because the lever
  // is real configuration and because deleting it would delete the reasoning; see
  // `RelaxationRule.secondaryCoverage` for the two occasions on which promoting
  // this to a hard gate excluded exactly the right person.
  const secondaries = required.filter((skill) => !skill.isPrimary);
  if (secondaries.length > 0 && rule.secondaryCoverage > 0) {
    const covered = secondaries.filter(
      (need) =>
        matchSkill(need, candidate.skills, {
          allowCategorySubstitute: rule.widenSecondaryToCategory,
          allRequiredSkillIds: required.map((skill) => skill.skillId),
        }).skill !== null,
    ).length;
    if (covered / secondaries.length < rule.secondaryCoverage) {
      reasons.push("INSUFFICIENT_SECONDARY_COVERAGE");
    }
  }

  if (rule.enforceRatingFloor && candidate.ratingCount >= context.thresholds.minRatedSessions) {
    // Waived below `minRatedSessions`: a new expert with two ratings has not
    // earned a low score, they have earned no score.
    if (shrunkRating(candidate, context.thresholds) < context.thresholds.minRating) {
      reasons.push("RATING_BELOW_FLOOR");
    }
  }

  if (rule.enforceLanguage && context.customerLanguages.length > 0) {
    const overlap = candidate.languages.some((language) =>
      context.customerLanguages.includes(language),
    );
    if (!overlap) reasons.push("NO_LANGUAGE_OVERLAP");
  }

  return reasons;
}

export function applyFilters(params: {
  readonly candidate: Candidate;
  readonly eligibility: CandidateEligibility;
  readonly context: FilterContext;
}): FilterOutcome {
  const reasons = [
    ...filterEligibility(params.eligibility, params.context),
    ...filterCompetence(params.candidate, params.context),
  ];

  return {
    passed: reasons.length === 0,
    reasons,
    permanent: reasons.some(
      (reason) =>
        PERMANENT_FOR_THIS_REQUEST.includes(reason) ||
        // Below the absolute floor is permanent even though at a lower
        // relaxation level `PRIMARY_BELOW_FLOOR` alone is not.
        (reason === "PRIMARY_BELOW_FLOOR" &&
          isBelowAbsoluteFloor(params.candidate, params.context.required)),
    ),
  };
}

/** True when relaxing all the way to the absolute floor still would not help. */
function isBelowAbsoluteFloor(candidate: Candidate, required: readonly RequiredSkill[]): boolean {
  return required
    .filter((skill) => skill.isPrimary)
    .some((need) => {
      const { skill } = matchSkill(need, candidate.skills, { allowCategorySubstitute: false });
      return skill !== null && !meetsFloor(skill.proficiencyLevel, ABSOLUTE_PRIMARY_FLOOR);
    });
}

/** Re-exported so callers do not need to reach into availability.ts. */
export { isHeartbeatFresh };
export type { ExclusionReason };
