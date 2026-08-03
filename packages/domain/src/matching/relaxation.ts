import type { ProficiencyLevel } from "@sfx/contracts";
import { meetsFloor, strictestFloor } from "./proficiency.js";

/**
 * The relaxation ladder (§C3, requirement 11).
 *
 * As the 15 minutes run down we widen the search. What we widen is deliberately
 * bounded, and the bound is not a policy that lives in a comment — it is
 * `ABSOLUTE_PRIMARY_FLOOR` applied by `floorForLevel`, which every level's floor
 * passes through. There is no level at which "any available Salesforce expert"
 * becomes a candidate.
 *
 * The user's framing, encoded literally: **a wrong expert is worse than no
 * expert**, because the product's entire promise is that we chose correctly. An
 * honest `NO_EXPERT_FOUND` costs one refund and one apology; a CPQ pricing-rule
 * question routed to a Flow admin costs the brand.
 */

/**
 * No relaxation level may go below this, now or ever.
 *
 * Enforced in `floorForLevel` rather than trusted to the table, so a
 * well-meaning edit to `RELAXATION_LADDER` cannot lower it by accident. A test
 * asserts the property across every level *and* across levels that do not
 * exist yet.
 */
export const ABSOLUTE_PRIMARY_FLOOR: ProficiencyLevel = "INTERMEDIATE";

export const MAX_RELAXATION_LEVEL = 3;

export interface RelaxationRule {
  readonly level: number;
  /** Minutes since the request was submitted at which this level engages. */
  readonly engagesAtMinutes: number;
  readonly primaryFloor: ProficiencyLevel;
  /**
   * Fraction of the request's secondary skills a candidate must hold.
   *
   * Deliberately low, even at level 0. The **primary** skill is the hard gate
   * (C3); secondary skills are supporting signals, and they already influence
   * the outcome through `skillScore` — an expert covering more of them ranks
   * higher. Turning them into a strict filter as well would double-count them
   * and let the filter, rather than the score, decide.
   *
   * This started at 1.0 and was wrong. A real classified request names three or
   * four supporting skills ("apex" primary; "triggers", "soql-sosl",
   * "governor-limits" secondary), and the taxonomy is finer-grained than
   * expertise is — someone ADVANCED in Apex who never separately declared
   * `soql-sosl` is still the right person for a SOQL-in-a-trigger problem. At
   * 1.0 nobody matched at level 0 and every request waited four minutes for
   * level 1. Found by running the loop end to end; the unit tests used
   * two-skill requests and never saw it.
   */
  readonly secondaryCoverage: number;
  /** Apply the shrunk-rating minimum at this level. */
  readonly enforceRatingFloor: boolean;
  /** Require overlap with the customer's stated languages. */
  readonly enforceLanguage: boolean;
  /**
   * Count a sibling skill in the same category as covering a required
   * secondary. Never applies to primary skills.
   */
  readonly widenSecondaryToCategory: boolean;
  readonly describes: string;
}

export const RELAXATION_LADDER: readonly RelaxationRule[] = [
  {
    level: 0,
    engagesAtMinutes: 0,
    primaryFloor: "ADVANCED",
    // A quarter of the supporting skills, which for the three or four a
    // classifier typically names means **at least one**. That is the real
    // intent: exclude someone with no overlap at all, and let the score reward
    // fuller coverage. Chosen at 0.25 rather than 1/3 because a threshold that
    // sits exactly on a common fraction is a threshold that excludes the case it
    // was written to admit — 1/3 = 0.333 fails a 0.34 test.
    secondaryCoverage: 0.25,
    enforceRatingFloor: true,
    enforceLanguage: true,
    widenSecondaryToCategory: false,
    describes: "The expert we would pick if we had all day.",
  },
  {
    level: 1,
    engagesAtMinutes: 4,
    primaryFloor: "ADVANCED",
    // Effectively at-least-one for any realistic skill list.
    secondaryCoverage: 0.1,
    enforceRatingFloor: false,
    enforceLanguage: true,
    widenSecondaryToCategory: false,
    describes: "Drop the rating floor and most of the secondary requirement. Primary is untouched.",
  },
  {
    level: 2,
    engagesAtMinutes: 8,
    primaryFloor: "INTERMEDIATE",
    // Zero: by now the only thing still being asked is primary competence, which
    // is exactly the thing that must not move.
    secondaryCoverage: 0,
    enforceRatingFloor: false,
    enforceLanguage: false,
    widenSecondaryToCategory: false,
    describes: "Primary floor reaches its absolute minimum. Language preference is dropped.",
  },
  {
    level: 3,
    engagesAtMinutes: 12,
    primaryFloor: "INTERMEDIATE",
    secondaryCoverage: 0,
    enforceRatingFloor: false,
    enforceLanguage: false,
    widenSecondaryToCategory: true,
    describes: "Secondary skills widen to the parent category. Primary still cannot move.",
  },
];

/**
 * The floor actually applied at a level.
 *
 * Every read of a primary floor goes through here. Two guards:
 * `strictestFloor` holds the absolute minimum whatever the table says, and an
 * unknown level falls back to the strictest rule rather than the loosest —
 * because the failure mode of "level 7 means no floor" is precisely the one
 * this whole mechanism exists to prevent.
 */
export function floorForLevel(level: number): ProficiencyLevel {
  const rule = RELAXATION_LADDER[clampLevel(level)];
  const tabled = rule?.primaryFloor ?? ABSOLUTE_PRIMARY_FLOOR;
  return strictestFloor(tabled, ABSOLUTE_PRIMARY_FLOOR);
}

export function ruleForLevel(level: number): RelaxationRule {
  const rule = RELAXATION_LADDER[clampLevel(level)];
  if (!rule) throw new Error(`No relaxation rule for level ${level}`);
  // Never hand back a floor the table happened to set below the absolute one.
  return { ...rule, primaryFloor: floorForLevel(level) };
}

function clampLevel(level: number): number {
  if (!Number.isFinite(level) || level < 0) return 0;
  return Math.min(Math.trunc(level), MAX_RELAXATION_LEVEL);
}

/**
 * Whether a candidate at this proficiency could *ever* qualify.
 *
 * Used to say something honest in the UI and the logs: an expert below the
 * absolute floor is not "not yet eligible", they are permanently out for this
 * request, and waiting will not change it.
 */
export function couldEverQualify(primaryProficiency: ProficiencyLevel): boolean {
  return meetsFloor(primaryProficiency, ABSOLUTE_PRIMARY_FLOOR);
}

/**
 * The level the schedule says we should be at, given elapsed time.
 *
 * Advisory. The dispatcher steps up when it runs out of candidates, not when
 * the clock says so — otherwise a healthy search with a queue of good
 * candidates would relax for no reason. This is the ceiling on that stepping,
 * so a search that exhausts its pool in the first ten seconds cannot jump
 * straight to level 3.
 */
export function scheduledLevel(elapsedMinutes: number): number {
  let level = 0;
  for (const rule of RELAXATION_LADDER) {
    if (elapsedMinutes >= rule.engagesAtMinutes) level = rule.level;
  }
  return level;
}
