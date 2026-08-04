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
  /**
   * Seconds since submission at which this level becomes available.
   *
   * Seconds rather than minutes because the launch schedule is not on whole
   * minutes — level 1 engages at 90s — and a unit that cannot express the
   * configured value is the wrong unit.
   *
   * This is the **default**. The live schedule comes from
   * `MatchingThresholds.relaxationScheduleSeconds`, which is configuration and
   * snapshots onto every `MatchingRun`, so production data can retune it and old
   * decisions still explain themselves (§C7).
   */
  readonly engagesAtSeconds: number;
  readonly primaryFloor: ProficiencyLevel;
  /**
   * Fraction of the request's secondary skills a candidate must hold.
   *
   * **Zero at every level, deliberately and permanently.** Secondary-skill
   * alignment is a *ranking* signal, not an eligibility one: it is carried by
   * `skillScore`, where a candidate covering more of the supporting skills ranks
   * higher and one covering none of them ranks lower. Using it as a filter too
   * double-counts it and lets the filter, rather than the score, decide.
   *
   * The field is retained rather than deleted so the lever still exists and its
   * history is legible. That history is the argument:
   *
   *   - **1.0 at level 0** (Phase 5, as designed). Nothing matched at level 0,
   *     because a real classified request names three or four supporting skills
   *     and no real expert declares all of them. Every request waited four
   *     minutes for level 1. Found only by running the loop end to end — the unit
   *     tests used two-skill requests and never saw it.
   *   - **0.25 at level 0** (Phase 5, after that). Better, and still wrong: a
   *     request classified `apex` + `batch-apex` excluded an expert holding
   *     `apex: ADVANCED` + `triggers: ADVANCED` — a genuinely good match for a
   *     batch Apex problem — at levels 0 *and* 1, offering it only at level 2.
   *     Measured: 180.5 seconds of a fifteen-minute promise, spent not offering
   *     work to someone who could have done it.
   *   - **0 everywhere** (Phase 6, approved). The taxonomy is finer-grained than
   *     expertise is, and treating "has not separately declared `soql-sosl`" as
   *     disqualifying for a SOQL-in-a-trigger problem was never the intent.
   *
   * The pattern is worth naming: twice, a supporting signal was promoted to a
   * hard gate and twice it excluded the right person. The **primary**-skill floor
   * is the hard gate (§C3), and it is the only one.
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
    engagesAtSeconds: 0,
    primaryFloor: "ADVANCED",
    // Not a gate. `skillScore` is where secondary coverage belongs — see the
    // field's doc comment for why this was 1.0, then 0.25, and is now 0.
    secondaryCoverage: 0,
    enforceRatingFloor: true,
    enforceLanguage: true,
    widenSecondaryToCategory: false,
    describes:
      "Deep primary competence, a rating floor, and a language match. The expert we would pick if we had all day.",
  },
  {
    level: 1,
    engagesAtSeconds: 90,
    primaryFloor: "ADVANCED",
    secondaryCoverage: 0,
    enforceRatingFloor: false,
    enforceLanguage: true,
    widenSecondaryToCategory: false,
    describes: "Drop the rating floor. Primary competence is untouched.",
  },
  {
    level: 2,
    engagesAtSeconds: 180,
    primaryFloor: "INTERMEDIATE",
    secondaryCoverage: 0,
    enforceRatingFloor: false,
    enforceLanguage: false,
    widenSecondaryToCategory: false,
    describes: "Primary floor reaches its absolute minimum. Language preference is dropped.",
  },
  {
    level: 3,
    engagesAtSeconds: 360,
    primaryFloor: "INTERMEDIATE",
    secondaryCoverage: 0,
    enforceRatingFloor: false,
    enforceLanguage: false,
    widenSecondaryToCategory: true,
    describes:
      "A sibling skill in the same category can stand in for a secondary when scoring. Primary still cannot move.",
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
 * The schedule the ladder ships with: **0s · 90s · 3m · 6m**, inside a
 * 15-minute deadline.
 *
 * Tuned for an instant-support marketplace with a small launch roster (Q14:
 * 10–20 hand-recruited experts). The first version was 0/4/8/12 minutes, which
 * is the right shape for a deep bench and the wrong one for a thin one: a
 * request that exhausts three qualified candidates in ten seconds would wait
 * four minutes before an INTERMEDIATE expert was even considered, and with
 * twenty experts on the roster that is most requests. Four minutes of a
 * fifteen-minute promise spent waiting for a level change the customer cannot
 * see is the worst possible use of it.
 *
 * Still bounded by the thing that does not move: every level's primary floor
 * passes through `floorForLevel`, so a faster ladder widens *sooner* and never
 * *further*.
 */
export const DEFAULT_RELAXATION_SCHEDULE_SECONDS: readonly number[] = RELAXATION_LADDER.map(
  (rule) => rule.engagesAtSeconds,
);

/**
 * The level the schedule permits, given elapsed time.
 *
 * Advisory. The dispatcher steps up when it runs out of candidates, not when the
 * clock says so — otherwise a healthy search with a queue of good candidates
 * would relax for no reason. This is the ceiling on that stepping, so a search
 * that exhausts its pool in the first ten seconds cannot jump straight to
 * level 3.
 *
 * The schedule is passed in rather than read from the table, because it is
 * configuration: the caller supplies whatever `MatchingThresholds` holds, and
 * that value is snapshotted onto the run.
 */
export function scheduledLevel(
  elapsedSeconds: number,
  schedule: readonly number[] = DEFAULT_RELAXATION_SCHEDULE_SECONDS,
): number {
  let level = 0;
  for (const [index, engagesAt] of schedule.entries()) {
    if (index > MAX_RELAXATION_LEVEL) break;
    if (elapsedSeconds >= engagesAt) level = index;
  }
  return level;
}

/**
 * Seconds from submission until a level becomes available, under a given
 * schedule. Used to schedule the re-dispatch that wakes the search up.
 */
export function engagesAtSeconds(
  level: number,
  schedule: readonly number[] = DEFAULT_RELAXATION_SCHEDULE_SECONDS,
): number {
  return schedule[clampLevel(level)] ?? DEFAULT_RELAXATION_SCHEDULE_SECONDS[clampLevel(level)] ?? 0;
}
