import type { ProficiencyLevel } from "@sfx/contracts";

/**
 * The competence ladder (§C3).
 *
 * Kept in its own file because two very different things depend on it and they
 * must not drift: the **hard floor**, which decides who is a candidate at all,
 * and the **score**, which decides how candidates are ordered. If ADVANCED
 * meant 0.75 to the scorer and something else to the filter, the floor would
 * stop meaning what the relaxation table says it means.
 */

/** Ordinal, low to high. The only place the ordering is defined. */
export const PROFICIENCY_ORDER: readonly ProficiencyLevel[] = [
  "BEGINNER",
  "INTERMEDIATE",
  "ADVANCED",
  "EXPERT",
];

const RANK: Record<ProficiencyLevel, number> = {
  BEGINNER: 0,
  INTERMEDIATE: 1,
  ADVANCED: 2,
  EXPERT: 3,
};

/** Numeric weight for scoring. Evenly spaced — no level is worth two of another. */
const VALUE: Record<ProficiencyLevel, number> = {
  BEGINNER: 0.25,
  INTERMEDIATE: 0.5,
  ADVANCED: 0.75,
  EXPERT: 1.0,
};

/**
 * How much an admin verification is worth.
 *
 * A 10% uplift, capped at 1.0. Deliberately small: requirement 5 says
 * verification may improve confidence but must not become mandatory in V1, and
 * a bonus large enough to reorder candidates would make it mandatory in
 * practice — an unverified EXPERT would lose to a verified ADVANCED, and every
 * expert would be pushing us to verify them before they could get work.
 *
 * At 1.1 the uplift can separate two experts at the *same* level. It cannot
 * promote one level past another: verified ADVANCED is 0.825, still below a
 * bare EXPERT's 1.0.
 */
export const VERIFIED_MULTIPLIER = 1.1;

export function proficiencyRank(level: ProficiencyLevel): number {
  return RANK[level];
}

export function meetsFloor(level: ProficiencyLevel, floor: ProficiencyLevel): boolean {
  return RANK[level] >= RANK[floor];
}

/** The scoring value of one declared skill, verification included. */
export function proficiencyValue(level: ProficiencyLevel, verified: boolean): number {
  const base = VALUE[level];
  return verified ? Math.min(1, base * VERIFIED_MULTIPLIER) : base;
}

/** Highest of two floors. Used to hold the absolute floor above the ladder. */
export function strictestFloor(a: ProficiencyLevel, b: ProficiencyLevel): ProficiencyLevel {
  return RANK[a] >= RANK[b] ? a : b;
}
