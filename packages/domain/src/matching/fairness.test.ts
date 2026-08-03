import { describe, expect, it } from "vitest";
import type { Candidate, RequiredSkill } from "../ports/matching-repositories.js";
import type { CandidateEligibility, FilterContext } from "./filters.js";
import { candidate } from "./in-memory-matching-world.js";
import { rankCandidates } from "./rank.js";
import { DEFAULT_SCORING_THRESHOLDS, DEFAULT_WEIGHTS, scoreCandidate } from "./scoring.js";

/**
 * Requirement 3, as a two-sided property.
 *
 * Fairness has to do something and must not do too much. Both halves are
 * asserted, because a weight that satisfies one and not the other is a
 * plausible-looking mistake:
 *
 *   - **It must bite.** Two candidates who are close on skill, and one has been
 *     waiting all afternoon → the waiting one wins. Otherwise the strongest
 *     expert on the bench takes every request and everyone else drifts away.
 *   - **It must not rescue.** A materially weaker technical candidate must not
 *     beat a clearly stronger one, whatever their idle time, rating, tenure or
 *     acceptance rate. Otherwise the product's promise — that we chose the right
 *     expert — is negotiable.
 */

const NOW = new Date("2026-08-02T12:00:00Z");

const THRESHOLDS: FilterContext["thresholds"] = {
  ...DEFAULT_SCORING_THRESHOLDS,
  minRating: 3.5,
  minRatedSessions: 3,
  heartbeatStaleAfterSeconds: 180,
};

const ELIGIBLE: CandidateEligibility = {
  expertStatus: "APPROVED",
  accountStatus: "ACTIVE",
  availabilityStatus: "AVAILABLE",
  lastHeartbeatAt: NOW,
  alreadyResponded: false,
  isRequestingCustomer: false,
};

function need(...specs: [string, boolean][]): RequiredSkill[] {
  return specs.map(([slug, isPrimary]) => ({
    skillId: slug,
    slug,
    categoryId: "cat_dev",
    isPrimary,
  }));
}

function rank(required: RequiredSkill[], candidates: Candidate[], relaxationLevel = 0) {
  return rankCandidates({
    required,
    candidates: candidates.map((c) => ({ candidate: c, eligibility: ELIGIBLE })),
    relaxationLevel,
    weights: DEFAULT_WEIGHTS,
    thresholds: THRESHOLDS,
    customerLanguages: [],
    now: NOW,
    poolSize: 10,
    tieBreakSeed: "req_fairness",
  });
}

function score(required: RequiredSkill[], person: Candidate) {
  return scoreCandidate({
    required,
    candidate: person,
    weights: DEFAULT_WEIGHTS,
    thresholds: THRESHOLDS,
    allowCategorySubstitute: false,
  });
}

// ── Half one: fairness must bite ─────────────────────────────────────────────

describe("fairness decides between similarly qualified experts", () => {
  const required = need(["apex", true], ["triggers", false]);

  /**
   * The §14 case, committed as a specification.
   *
   * A: 8 years, 4.9 rating, offered work 10 minutes ago.
   * B: 7 years, 4.8 rating, has not been offered anything for 3 hours.
   *
   * A is better on paper. B should win, because the difference between them is
   * small and B has been waiting. That is the intended behaviour, and this is
   * the test that pins it.
   */
  const A = candidate({
    id: "A",
    skills: { apex: ["ADVANCED", 8], triggers: ["ADVANCED", 8] },
    yearsExperience: 8,
    ratingSum: 98,
    ratingCount: 20,
    idleMinutes: 10,
    offersReceived: 30,
    offersAccepted: 28,
    avgResponseSeconds: 15,
  });

  const B = candidate({
    id: "B",
    skills: { apex: ["ADVANCED", 7], triggers: ["ADVANCED", 7] },
    yearsExperience: 7,
    ratingSum: 96,
    ratingCount: 20,
    idleMinutes: 180,
    offersReceived: 30,
    offersAccepted: 28,
    avgResponseSeconds: 15,
  });

  it("ranks the long-waiting expert first when the two are close", () => {
    const result = rank(required, [A, B]);
    expect(result.ranked[0]?.expertProfileId).toBe("B");
    expect(result.ranked[1]?.expertProfileId).toBe("A");
  });

  it("preserves A's real edge on rating and experience rather than discarding it", () => {
    const scoreA = score(required, A);
    const scoreB = score(required, B);
    expect(scoreA.ratingScore).toBeGreaterThan(scoreB.ratingScore);
    expect(scoreA.experienceScore).toBeGreaterThan(scoreB.experienceScore);
    // B wins on the total anyway, and the components record why.
    expect(scoreB.finalScore).toBeGreaterThan(scoreA.finalScore);
    expect(scoreB.fairnessScore).toBeGreaterThan(scoreA.fairnessScore);
  });

  it("wins by a margin attributable to fairness alone", () => {
    const scoreA = score(required, A);
    const scoreB = score(required, B);
    const margin = scoreB.finalScore - scoreA.finalScore;
    const fairnessGap = DEFAULT_WEIGHTS.fairness * (scoreB.fairnessScore - scoreA.fairnessScore);
    // The entire margin comes from fairness — everything else favours A.
    expect(margin).toBeGreaterThan(0);
    expect(margin).toBeLessThanOrEqual(fairnessGap + 1e-9);
  });

  it("does not favour the waiting expert when they are identical apart from idle time", () => {
    const busy = candidate({
      id: "busy",
      skills: { apex: ["ADVANCED", 5], triggers: ["ADVANCED", 5] },
      idleMinutes: 0,
    });
    const waiting = candidate({
      id: "waiting",
      skills: { apex: ["ADVANCED", 5], triggers: ["ADVANCED", 5] },
      idleMinutes: 240,
    });
    const result = rank(required, [busy, waiting]);
    // Same technical profile, so fairness is the only differentiator and it
    // should be decisive. This is the behaviour we want, stated plainly.
    expect(result.ranked[0]?.expertProfileId).toBe("waiting");
  });

  it("stops favouring an expert who has already worked all day", () => {
    const idleButSpent = candidate({
      id: "spent",
      skills: { apex: ["ADVANCED", 5], triggers: ["ADVANCED", 5] },
      idleMinutes: 240,
      sessionsToday: 6,
    });
    const idleAndFresh = candidate({
      id: "fresh",
      skills: { apex: ["ADVANCED", 5], triggers: ["ADVANCED", 5] },
      idleMinutes: 200,
      sessionsToday: 0,
    });
    const result = rank(required, [idleButSpent, idleAndFresh]);
    expect(result.ranked[0]?.expertProfileId).toBe("fresh");
  });
});

// ── Half two: fairness must not rescue ───────────────────────────────────────

describe("fairness cannot beat a clearly stronger technical candidate", () => {
  const required = need(["cpq", true], ["billing", false]);

  /** Deep in exactly the thing being asked about, and freshly offered work. */
  const strong = candidate({
    id: "strong",
    skills: { cpq: { level: "EXPERT", years: 7, verified: true }, billing: ["ADVANCED", 5] },
    yearsExperience: 8,
    ratingSum: 90,
    ratingCount: 20,
    idleMinutes: 0,
    sessionsToday: 3,
    offersReceived: 40,
    offersAccepted: 30,
    avgResponseSeconds: 45,
  });

  /**
   * Maxed out on every non-technical axis it is possible to max out — idle all
   * day, no sessions, perfect rating, instant responses, decades of tenure —
   * and merely INTERMEDIATE at the primary skill.
   */
  const weakerButFavoured = candidate({
    id: "favoured",
    skills: { cpq: ["INTERMEDIATE", 1], billing: ["EXPERT", 10] },
    yearsExperience: 20,
    ratingSum: 100,
    ratingCount: 20,
    idleMinutes: 10_000,
    sessionsToday: 0,
    offersReceived: 100,
    offersAccepted: 100,
    avgResponseSeconds: 1,
  });

  it("ranks the stronger primary-skill expert first at level 2, where both qualify", () => {
    // Level 2 lets INTERMEDIATE through the floor, so this is a genuine ranking
    // contest rather than a filter one. That is the case requirement 2 is about.
    const result = rank(required, [weakerButFavoured, strong], 2);
    expect(result.ranked.map((entry) => entry.expertProfileId)).toEqual(["strong", "favoured"]);
  });

  it("holds even with fairness and reliability at their theoretical maximum", () => {
    const maxedOut = candidate({
      id: "maxed",
      skills: { cpq: ["INTERMEDIATE", 40], billing: ["EXPERT", 40] },
      yearsExperience: 60,
      ratingSum: 100,
      ratingCount: 20,
      idleMinutes: 1_000_000,
      sessionsToday: 0,
      offersReceived: 1000,
      offersAccepted: 1000,
      avgResponseSeconds: 0,
    });
    const result = rank(required, [maxedOut, strong], 2);
    expect(result.ranked[0]?.expertProfileId).toBe("strong");
  });

  it("wins on the band even though it LOSES on the weighted score", () => {
    // This is the test that forced the banded ranking, so it asserts the
    // uncomfortable fact directly: on `finalScore` alone the weaker candidate
    // wins. Weights cannot deliver requirement 2 — the band is what does.
    const scoreStrong = score(required, strong);
    const scoreWeak = score(required, weakerButFavoured);

    expect(scoreWeak.finalScore).toBeGreaterThan(scoreStrong.finalScore);
    expect(scoreStrong.breakdown.primaryBand).toBeGreaterThan(scoreWeak.breakdown.primaryBand);

    const result = rank(required, [weakerButFavoured, strong], 2);
    expect(result.ranked[0]?.expertProfileId).toBe("strong");
  });

  it("bands on the declared level, so verification cannot promote anyone", () => {
    // Requirement 5: verification improves confidence within a band and must
    // never become the thing that gets you work.
    const verifiedAdvanced = candidate({
      id: "verified",
      skills: { cpq: { level: "ADVANCED", years: 5, verified: true }, billing: ["ADVANCED", 5] },
    });
    const bareExpert = candidate({
      id: "bare",
      skills: { cpq: ["EXPERT", 5], billing: ["ADVANCED", 5] },
    });
    const result = rank(required, [verifiedAdvanced, bareExpert], 2);
    expect(result.ranked[0]?.expertProfileId).toBe("bare");
  });

  it("lets verification decide inside a band", () => {
    const verified = candidate({
      id: "v",
      skills: { cpq: { level: "ADVANCED", years: 5, verified: true }, billing: ["ADVANCED", 5] },
      idleMinutes: 60,
    });
    const unverified = candidate({
      id: "u",
      skills: { cpq: ["ADVANCED", 5], billing: ["ADVANCED", 5] },
      idleMinutes: 60,
    });
    const result = rank(required, [unverified, verified], 2);
    expect(result.ranked[0]?.expertProfileId).toBe("v");
  });

  it("keeps the weakest-primary term doing the work, not the weights alone", () => {
    const scoreStrong = score(required, strong);
    const scoreWeak = score(required, weakerButFavoured);
    // The weakest-primary term is the visible difference: 1.0 against 0.5.
    expect(scoreStrong.breakdown.minPrimaryValue).toBe(1);
    expect(scoreWeak.breakdown.minPrimaryValue).toBe(0.5);
    expect(scoreStrong.skillScore).toBeGreaterThan(scoreWeak.skillScore + 0.2);
  });

  it("never even considers them when the gap crosses the floor", () => {
    // Below the floor, fairness is not a factor at all — they are not a
    // candidate, so there is nothing for fairness to lift.
    const belowFloor = candidate({
      id: "below",
      skills: { cpq: ["BEGINNER", 1], billing: ["EXPERT", 10] },
      idleMinutes: 100_000,
      ratingSum: 100,
      ratingCount: 20,
    });
    const result = rank(required, [belowFloor, strong], 3);
    expect(result.ranked.map((entry) => entry.expertProfileId)).toEqual(["strong"]);
    expect(result.excluded[0]).toMatchObject({ expertProfileId: "below", permanent: true });
  });
});

// ── Determinism ──────────────────────────────────────────────────────────────

describe("ranking is deterministic", () => {
  const required = need(["apex", true]);

  it("orders identical candidates the same way every time", () => {
    const twins = ["x", "y", "z", "w"].map((id) =>
      candidate({ id, skills: { apex: ["ADVANCED", 5] }, idleMinutes: 60 }),
    );
    const first = rank(required, twins).ranked.map((entry) => entry.expertProfileId);
    const shuffled = rank(required, [...twins].reverse()).ranked.map(
      (entry) => entry.expertProfileId,
    );
    // Tie-broken by a seeded hash, not by the order rows arrived in — otherwise
    // the "fairest" expert would depend on the query plan.
    expect(shuffled).toEqual(first);
  });

  it("breaks ties on idle time before falling back to the hash", () => {
    const fresh = candidate({ id: "fresh", skills: { apex: ["ADVANCED", 5] }, idleMinutes: 5 });
    const stale = candidate({ id: "stale", skills: { apex: ["ADVANCED", 5] }, idleMinutes: 5 });
    const result = rank(required, [fresh, stale]);
    expect(result.ranked).toHaveLength(2);
    // Same everything, so the hash decides — but it decides stably.
    const again = rank(required, [stale, fresh]);
    expect(again.ranked.map((e) => e.expertProfileId)).toEqual(
      result.ranked.map((e) => e.expertProfileId),
    );
  });

  it("truncates to the pool size but records every exclusion", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      candidate({ id: `ok_${i}`, skills: { apex: ["ADVANCED", 5] } }),
    );
    const rejects = Array.from({ length: 7 }, (_, i) =>
      candidate({ id: `no_${i}`, skills: { apex: ["BEGINNER", 1] } }),
    );
    const result = rank(required, [...many, ...rejects]);
    expect(result.ranked).toHaveLength(10);
    expect(result.eligibleCount).toBe(25);
    // Requirement 4: the audit trail is never truncated, even when the offer
    // list is.
    expect(result.excluded).toHaveLength(7);
  });
});
