import { describe, expect, it } from "vitest";
import { candidate } from "./in-memory-matching-world.js";
import { proficiencyValue, VERIFIED_MULTIPLIER } from "./proficiency.js";
import {
  DEFAULT_SCORING_THRESHOLDS,
  DEFAULT_WEIGHTS,
  scoreCandidate,
  scoreExperience,
  scoreFairness,
  scoreRating,
  scoreReliability,
  scoreSkills,
  shrunkRating,
  type RequiredSkill,
} from "./scoring.js";

/**
 * The scoring arithmetic, asserted directly.
 *
 * These are the numbers every ranking decision is built from, so they are
 * tested as arithmetic rather than only through the pipeline — a change that
 * shifts `skillScore` by 0.05 should fail here, loudly, rather than silently
 * reorder a bench somewhere.
 */

const NO_SUBSTITUTE = { allowCategorySubstitute: false };

function required(...specs: [string, boolean][]): RequiredSkill[] {
  return specs.map(([slug, isPrimary]) => ({
    skillId: slug,
    slug,
    categoryId: "cat_default",
    isPrimary,
  }));
}

describe("proficiency values", () => {
  it("spaces the four levels evenly", () => {
    expect(proficiencyValue("BEGINNER", false)).toBe(0.25);
    expect(proficiencyValue("INTERMEDIATE", false)).toBe(0.5);
    expect(proficiencyValue("ADVANCED", false)).toBe(0.75);
    expect(proficiencyValue("EXPERT", false)).toBe(1);
  });

  it("gives verification a bonus that cannot promote one level past another", () => {
    // Requirement 5: verification improves confidence, it does not become
    // mandatory. A verified ADVANCED must still lose to a bare EXPERT — else
    // every expert would need verifying before they could get work.
    expect(proficiencyValue("ADVANCED", true)).toBeCloseTo(0.75 * VERIFIED_MULTIPLIER, 5);
    expect(proficiencyValue("ADVANCED", true)).toBeLessThan(proficiencyValue("EXPERT", false));
    expect(proficiencyValue("INTERMEDIATE", true)).toBeLessThan(
      proficiencyValue("ADVANCED", false),
    );
  });

  it("caps a verified EXPERT at 1", () => {
    expect(proficiencyValue("EXPERT", true)).toBe(1);
  });
});

describe("skillScore — requirement 2, primary competence dominates", () => {
  const need = required(["copado", true], ["git", false], ["deploy", false]);

  it("scores a strong specialist highly", () => {
    const specialist = candidate({
      id: "A",
      skills: { copado: "EXPERT", git: "ADVANCED", deploy: "ADVANCED" },
    });
    const result = scoreSkills(need, specialist, NO_SUBSTITUTE);
    expect(result.skillScore).toBeGreaterThan(0.85);
    expect(result.minPrimaryValue).toBe(1);
  });

  it("holds a weak primary against a candidate however broad they are", () => {
    // Every secondary maxed out, primary merely INTERMEDIATE. The weakest-link
    // term is what stops breadth substituting for depth.
    const broad = candidate({
      id: "B",
      skills: { copado: "INTERMEDIATE", git: "EXPERT", deploy: "EXPERT" },
    });
    const narrow = candidate({
      id: "C",
      skills: { copado: "EXPERT", git: "INTERMEDIATE", deploy: "INTERMEDIATE" },
    });

    const broadScore = scoreSkills(need, broad, NO_SUBSTITUTE);
    const narrowScore = scoreSkills(need, narrow, NO_SUBSTITUTE);

    expect(narrowScore.skillScore).toBeGreaterThan(broadScore.skillScore);
  });

  it("counts a missing skill as zero rather than skipping it", () => {
    const partial = candidate({ id: "D", skills: { copado: "EXPERT" } });
    const complete = candidate({
      id: "E",
      skills: { copado: "EXPERT", git: "ADVANCED", deploy: "ADVANCED" },
    });
    expect(scoreSkills(need, partial, NO_SUBSTITUTE).skillScore).toBeLessThan(
      scoreSkills(need, complete, NO_SUBSTITUTE).skillScore,
    );
  });

  it("takes the weakest primary, not the average of them", () => {
    const twoPrimaries = required(["apex", true], ["cpq", true]);
    const uneven = candidate({ id: "F", skills: { apex: "EXPERT", cpq: "INTERMEDIATE" } });
    expect(scoreSkills(twoPrimaries, uneven, NO_SUBSTITUTE).minPrimaryValue).toBe(0.5);
  });

  it("falls back to the average when the request names no primary skill", () => {
    const noPrimary = required(["apex", false], ["flow", false]);
    const anyone = candidate({ id: "G", skills: { apex: "ADVANCED", flow: "ADVANCED" } });
    const result = scoreSkills(noPrimary, anyone, NO_SUBSTITUTE);
    // Not zero. There is no primary to protect, so the weakest-link term must
    // not punish everyone equally.
    expect(result.skillScore).toBeCloseTo(0.75, 3);
  });

  it("records per-skill detail for the audit trail", () => {
    const expert = candidate({
      id: "H",
      skills: { copado: { level: "EXPERT", verified: true }, git: "ADVANCED", deploy: "BEGINNER" },
    });
    const detail = scoreSkills(need, expert, NO_SUBSTITUTE).perSkill;
    expect(detail).toHaveLength(3);
    expect(detail[0]).toMatchObject({ slug: "copado", isPrimary: true, verified: true, value: 1 });
    expect(detail[2]).toMatchObject({ slug: "deploy", isPrimary: false, value: 0.25 });
  });
});

describe("category substitution", () => {
  const need = required(["copado", true], ["git", false]);

  it("never substitutes for a primary skill, even at maximum relaxation", () => {
    const sibling = candidate({
      id: "I",
      skills: { "sfdx-cli": { level: "EXPERT", category: "cat_default" } },
      categoryOf: { "sfdx-cli": "cat_default" },
    });
    const result = scoreSkills(need, sibling, { allowCategorySubstitute: true });
    expect(result.perSkill[0]).toMatchObject({ slug: "copado", value: 0, viaCategory: false });
  });

  it("substitutes a sibling for a secondary skill when permitted", () => {
    const sibling = candidate({
      id: "J",
      skills: {
        copado: "EXPERT",
        "sfdx-cli": { level: "ADVANCED", category: "cat_default" },
      },
    });
    const result = scoreSkills(need, sibling, { allowCategorySubstitute: true });
    expect(result.perSkill[1]).toMatchObject({ slug: "git", viaCategory: true, value: 0.75 });
  });
});

describe("ratingScore", () => {
  it("shrinks a tiny sample toward the prior", () => {
    const oneReview = candidate({ id: "K", skills: {}, ratingSum: 5, ratingCount: 1 });
    const manyReviews = candidate({ id: "L", skills: {}, ratingSum: 480, ratingCount: 100 });
    // One 5-star must not beat a hundred 4.8s.
    expect(scoreRating(oneReview, DEFAULT_SCORING_THRESHOLDS)).toBeLessThan(
      scoreRating(manyReviews, DEFAULT_SCORING_THRESHOLDS),
    );
  });

  it("starts an unrated expert at the prior, not at zero", () => {
    const unrated = candidate({ id: "M", skills: {} });
    expect(shrunkRating(unrated, DEFAULT_SCORING_THRESHOLDS)).toBe(4.5);
  });
});

describe("experienceScore", () => {
  it("saturates so tenure cannot substitute for competence", () => {
    const need = required(["apex", true]);
    const ten = candidate({ id: "N", skills: { apex: ["EXPERT", 8] }, yearsExperience: 10 });
    const thirty = candidate({ id: "O", skills: { apex: ["EXPERT", 30] }, yearsExperience: 30 });
    expect(scoreExperience(need, ten)).toBe(scoreExperience(need, thirty));
    expect(scoreExperience(need, ten)).toBe(1);
  });

  it("uses years in the requested skills, not just overall tenure", () => {
    const need = required(["cpq", true]);
    const veteranNewToCpq = candidate({
      id: "P",
      skills: { cpq: ["ADVANCED", 0] },
      yearsExperience: 10,
    });
    const veteranDeepInCpq = candidate({
      id: "Q",
      skills: { cpq: ["ADVANCED", 8] },
      yearsExperience: 10,
    });
    expect(scoreExperience(need, veteranNewToCpq)).toBeLessThan(
      scoreExperience(need, veteranDeepInCpq),
    );
  });
});

describe("fairnessScore", () => {
  it("rises with idle time and saturates at the horizon", () => {
    const fresh = candidate({ id: "R", skills: {}, idleMinutes: 0 });
    const waiting = candidate({ id: "S", skills: {}, idleMinutes: 120 });
    const allDay = candidate({ id: "T", skills: {}, idleMinutes: 600 });

    expect(scoreFairness(fresh, DEFAULT_SCORING_THRESHOLDS)).toBe(0);
    expect(scoreFairness(waiting, DEFAULT_SCORING_THRESHOLDS)).toBe(0.5);
    expect(scoreFairness(allDay, DEFAULT_SCORING_THRESHOLDS)).toBe(1);
  });

  it("treats a never-offered expert as maximally idle", () => {
    // Otherwise a new expert is starved by a metric that only starts counting
    // after their first offer.
    const brandNew = candidate({ id: "U", skills: {}, idleMinutes: null });
    expect(scoreFairness(brandNew, DEFAULT_SCORING_THRESHOLDS)).toBe(1);
  });

  it("discounts an expert who has already worked a lot today", () => {
    const rested = candidate({ id: "V", skills: {}, idleMinutes: 240, sessionsToday: 0 });
    const busy = candidate({ id: "W", skills: {}, idleMinutes: 240, sessionsToday: 6 });
    expect(scoreFairness(busy, DEFAULT_SCORING_THRESHOLDS)).toBeLessThan(
      scoreFairness(rested, DEFAULT_SCORING_THRESHOLDS),
    );
    expect(scoreFairness(busy, DEFAULT_SCORING_THRESHOLDS)).toBe(0.7);
  });
});

describe("reliabilityScore", () => {
  it("shrinks acceptance rate, so one-for-one is not 100%", () => {
    const oneOffer = candidate({ id: "X", skills: {}, offersReceived: 1, offersAccepted: 1 });
    expect(scoreReliability(oneOffer)).toBeLessThan(1);
  });

  it("rewards answering quickly, mildly", () => {
    const quick = candidate({ id: "Y", skills: {}, avgResponseSeconds: 5 });
    const slow = candidate({ id: "Z", skills: {}, avgResponseSeconds: 55 });
    const gap = scoreReliability(quick) - scoreReliability(slow);
    expect(gap).toBeGreaterThan(0);
    // Speed is worth at most 0.2 of the component, which is 0.1 of the total.
    expect(gap).toBeLessThan(0.2);
  });
});

describe("the composed score", () => {
  it("sums to the weighted total of its parts", () => {
    const need = required(["apex", true]);
    const person = candidate({
      id: "AA",
      skills: { apex: ["ADVANCED", 5] },
      yearsExperience: 6,
      ratingSum: 48,
      ratingCount: 10,
      idleMinutes: 60,
      offersReceived: 20,
      offersAccepted: 18,
      avgResponseSeconds: 20,
    });

    const score = scoreCandidate({
      required: need,
      candidate: person,
      weights: DEFAULT_WEIGHTS,
      thresholds: DEFAULT_SCORING_THRESHOLDS,
      allowCategorySubstitute: false,
    });

    const recomputed =
      DEFAULT_WEIGHTS.skill * score.skillScore +
      DEFAULT_WEIGHTS.rating * score.ratingScore +
      DEFAULT_WEIGHTS.experience * score.experienceScore +
      DEFAULT_WEIGHTS.fairness * score.fairnessScore +
      DEFAULT_WEIGHTS.reliability * score.reliabilityScore;

    // Requirement 4: the persisted components must reproduce the persisted
    // total, or "why B and not A" is unanswerable from the audit row alone.
    expect(score.finalScore).toBeCloseTo(recomputed, 3);
  });

  it("keeps the weights summing to 1", () => {
    const total = Object.values(DEFAULT_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
    expect(total).toBeCloseTo(1, 10);
  });
});
