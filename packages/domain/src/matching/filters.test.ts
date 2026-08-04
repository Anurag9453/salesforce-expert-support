import type { ExpertStatus, ProficiencyLevel } from "@sfx/contracts";
import { describe, expect, it } from "vitest";
import type { RequiredSkill } from "../ports/matching-repositories.js";
import {
  applyFilters,
  EXCLUSION_COPY,
  type CandidateEligibility,
  type FilterContext,
} from "./filters.js";
import { candidate } from "./in-memory-matching-world.js";
import { PROFICIENCY_ORDER } from "./proficiency.js";
import {
  ABSOLUTE_PRIMARY_FLOOR,
  couldEverQualify,
  DEFAULT_RELAXATION_SCHEDULE_SECONDS,
  engagesAtSeconds,
  floorForLevel,
  MAX_RELAXATION_LEVEL,
  RELAXATION_LADDER,
  ruleForLevel,
  scheduledLevel,
} from "./relaxation.js";
import { DEFAULT_SCORING_THRESHOLDS, DEFAULT_WEIGHTS, scoreCandidate } from "./scoring.js";

/**
 * The hard filters, and the floor the relaxation ladder can never cross.
 *
 * The Copado case is here as a **named regression test** rather than as an
 * illustration, because it is the concrete example the user used to specify the
 * behaviour: a brilliant generalist with BEGINNER Copado must never reach a
 * Copado request, at any relaxation level, however good the rest of their
 * profile is.
 */

const NOW = new Date("2026-08-02T12:00:00Z");

const THRESHOLDS: FilterContext["thresholds"] = {
  ...DEFAULT_SCORING_THRESHOLDS,
  minRating: 3.5,
  minRatedSessions: 3,
  heartbeatStaleAfterSeconds: 180,
};

function context(level: number, overrides: Partial<FilterContext> = {}): FilterContext {
  return {
    required: [],
    rule: ruleForLevel(level),
    thresholds: THRESHOLDS,
    customerLanguages: [],
    now: NOW,
    ...overrides,
  };
}

function eligible(overrides: Partial<CandidateEligibility> = {}): CandidateEligibility {
  return {
    expertStatus: "APPROVED",
    accountStatus: "ACTIVE",
    availabilityStatus: "AVAILABLE",
    lastHeartbeatAt: NOW,
    alreadyResponded: false,
    isRequestingCustomer: false,
    ...overrides,
  };
}

function required(...specs: [string, boolean][]): RequiredSkill[] {
  return specs.map(([slug, isPrimary]) => ({
    skillId: slug,
    slug,
    categoryId: "cat_devops",
    isPrimary,
  }));
}

// ── The named regression case ────────────────────────────────────────────────

describe("the Copado disqualification (§C3, requirement 2)", () => {
  const need = required(["copado", true], ["git", false], ["metadata-deployment", false]);

  const specialist = candidate({
    id: "A",
    skills: {
      copado: ["EXPERT", 6],
      git: ["ADVANCED", 8],
      "metadata-deployment": ["ADVANCED", 7],
    },
    yearsExperience: 7,
    ratingSum: 44,
    ratingCount: 10,
  });

  /**
   * The generalist. Better than the specialist on every axis the score
   * measures — more tenure, a higher rating, idle all afternoon, near-perfect
   * acceptance — and BEGINNER at the one thing being asked about.
   */
  const generalist = candidate({
    id: "B",
    skills: {
      copado: ["BEGINNER", 1],
      git: ["INTERMEDIATE", 10],
      "metadata-deployment": ["EXPERT", 12],
    },
    yearsExperience: 14,
    ratingSum: 98,
    ratingCount: 20,
    idleMinutes: 480,
    offersReceived: 40,
    offersAccepted: 39,
    avgResponseSeconds: 4,
  });

  it("admits the specialist at level 0", () => {
    const outcome = applyFilters({
      candidate: specialist,
      eligibility: eligible(),
      context: context(0, { required: need }),
    });
    expect(outcome.passed).toBe(true);
    expect(outcome.reasons).toEqual([]);
  });

  it("disqualifies the generalist at level 0", () => {
    const outcome = applyFilters({
      candidate: generalist,
      eligibility: eligible(),
      context: context(0, { required: need }),
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.reasons).toContain("PRIMARY_BELOW_FLOOR");
  });

  it("still disqualifies the generalist at MAXIMUM relaxation", () => {
    // The whole point. Every other lever is relaxed; this one cannot be.
    for (let level = 0; level <= MAX_RELAXATION_LEVEL; level++) {
      const outcome = applyFilters({
        candidate: generalist,
        eligibility: eligible(),
        context: context(level, { required: need }),
      });
      expect(outcome.passed, `level ${level} must still exclude them`).toBe(false);
      expect(outcome.reasons).toContain("PRIMARY_BELOW_FLOOR");
    }
  });

  it("marks the exclusion as permanent, so nothing waits for them", () => {
    const outcome = applyFilters({
      candidate: generalist,
      eligibility: eligible(),
      context: context(0, { required: need }),
    });
    expect(outcome.permanent).toBe(true);
  });

  it("never lets a sibling skill stand in for the primary one", () => {
    // At level 3 secondary skills widen to the category. `metadata-deployment`
    // is in the same category as `copado`, and EXPERT — if substitution applied
    // to primaries, this candidate would sail through.
    const outcome = applyFilters({
      candidate: generalist,
      eligibility: eligible(),
      context: context(3, { required: need }),
    });
    expect(outcome.passed).toBe(false);
  });
});

// ── The floor, as a property ─────────────────────────────────────────────────

describe("the absolute primary-skill floor (requirement 11)", () => {
  it("is INTERMEDIATE", () => {
    expect(ABSOLUTE_PRIMARY_FLOOR).toBe("INTERMEDIATE");
  });

  it("holds at every declared level", () => {
    for (const rule of RELAXATION_LADDER) {
      const index = PROFICIENCY_ORDER.indexOf(floorForLevel(rule.level));
      const absolute = PROFICIENCY_ORDER.indexOf(ABSOLUTE_PRIMARY_FLOOR);
      expect(index, `level ${rule.level}`).toBeGreaterThanOrEqual(absolute);
    }
  });

  it("holds for levels that do not exist, in both directions", () => {
    // A future edit that adds a level, or a bug that passes a nonsense one,
    // must not be able to open the floor. Out-of-range clamps to the strictest
    // rule rather than to the loosest.
    for (const level of [-5, -1, 4, 7, 99, Number.NaN, Number.POSITIVE_INFINITY]) {
      const index = PROFICIENCY_ORDER.indexOf(floorForLevel(level));
      expect(index, `level ${level}`).toBeGreaterThanOrEqual(
        PROFICIENCY_ORDER.indexOf(ABSOLUTE_PRIMARY_FLOOR),
      );
    }
  });

  it("holds even if the ladder table were edited to a lower floor", () => {
    // `ruleForLevel` passes the tabled value through `strictestFloor`, so the
    // guarantee does not depend on the table being right.
    expect(ruleForLevel(0).primaryFloor).toBe("ADVANCED");
    expect(ruleForLevel(2).primaryFloor).toBe("INTERMEDIATE");
    expect(ruleForLevel(3).primaryFloor).toBe("INTERMEDIATE");
  });

  it("tells the truth about who could ever qualify", () => {
    expect(couldEverQualify("BEGINNER")).toBe(false);
    expect(couldEverQualify("INTERMEDIATE")).toBe(true);
    expect(couldEverQualify("ADVANCED")).toBe(true);
    expect(couldEverQualify("EXPERT")).toBe(true);
  });

  it("never widens all the way to any-available-expert", () => {
    // There is no level at which a request with a primary skill accepts a
    // candidate who has not declared it.
    const need = required(["cpq", true]);
    const flowAdmin = candidate({ id: "C", skills: { flow: "EXPERT" } });
    for (let level = 0; level <= MAX_RELAXATION_LEVEL; level++) {
      const outcome = applyFilters({
        candidate: flowAdmin,
        eligibility: eligible(),
        context: context(level, { required: need }),
      });
      expect(outcome.passed, `level ${level}`).toBe(false);
      expect(outcome.reasons).toContain("MISSING_PRIMARY_SKILL");
    }
  });
});

describe("the relaxation ladder", () => {
  it("loosens monotonically and never tightens", () => {
    for (let level = 1; level <= MAX_RELAXATION_LEVEL; level++) {
      const previous = ruleForLevel(level - 1);
      const current = ruleForLevel(level);
      expect(
        PROFICIENCY_ORDER.indexOf(current.primaryFloor),
        `floor at level ${level}`,
      ).toBeLessThanOrEqual(PROFICIENCY_ORDER.indexOf(previous.primaryFloor));
      expect(current.secondaryCoverage).toBeLessThanOrEqual(previous.secondaryCoverage);
    }
  });

  it("engages levels on the launch schedule — 0s, 90s, 3m, 6m", () => {
    expect(scheduledLevel(0)).toBe(0);
    expect(scheduledLevel(89)).toBe(0);
    expect(scheduledLevel(90)).toBe(1);
    expect(scheduledLevel(179)).toBe(1);
    expect(scheduledLevel(180)).toBe(2);
    expect(scheduledLevel(359)).toBe(2);
    expect(scheduledLevel(360)).toBe(3);
    // Still level 3 right up to the deadline; there is no level 4 to reach.
    expect(scheduledLevel(14 * 60)).toBe(3);
  });

  it("reaches maximum relaxation with most of the window still left", () => {
    // The point of the retune. Under the old 0/4/8/12 schedule a thin bench sat
    // at level 0 for four minutes; now every level is available inside the first
    // six, leaving nine minutes of the promise to actually find someone.
    expect(DEFAULT_RELAXATION_SCHEDULE_SECONDS.at(-1)).toBe(360);
    expect(DEFAULT_RELAXATION_SCHEDULE_SECONDS.at(-1)!).toBeLessThan(15 * 60);
  });

  it("takes a caller-supplied schedule, because it is configuration", () => {
    const faster = [0, 10, 20, 30];
    expect(scheduledLevel(15, faster)).toBe(1);
    expect(scheduledLevel(35, faster)).toBe(3);
    // And a slower one cannot reach a level the caller did not permit.
    expect(scheduledLevel(15, [0, 600, 900, 1200])).toBe(0);
  });

  it("reports when each level engages, for scheduling the wake-up", () => {
    expect(engagesAtSeconds(0)).toBe(0);
    expect(engagesAtSeconds(1)).toBe(90);
    expect(engagesAtSeconds(3)).toBe(360);
    // Out of range clamps rather than returning undefined.
    expect(engagesAtSeconds(99)).toBe(360);
  });

  it("cannot be configured to lower the floor", () => {
    // A faster schedule widens sooner and never further. The floors are
    // unchanged by any schedule the caller supplies.
    for (let level = 0; level <= MAX_RELAXATION_LEVEL; level++) {
      expect(ruleForLevel(level).primaryFloor).toBe(level < 2 ? "ADVANCED" : "INTERMEDIATE");
    }
  });

  it("relaxes the rating floor before it relaxes competence", () => {
    // Ordering matters: a slightly lower-rated expert who is deeply competent is
    // a better answer than a well-rated one who is not.
    expect(ruleForLevel(0).enforceRatingFloor).toBe(true);
    expect(ruleForLevel(1).enforceRatingFloor).toBe(false);
    expect(ruleForLevel(1).primaryFloor).toBe("ADVANCED");
  });
});

// ── Stage 1 ──────────────────────────────────────────────────────────────────

describe("eligibility filtering (stage 1)", () => {
  const need = required(["apex", true]);
  const able = candidate({ id: "D", skills: { apex: "EXPERT" } });

  const blocked: [Partial<CandidateEligibility>, string][] = [
    [{ expertStatus: "DRAFT" }, "NOT_APPROVED"],
    [{ expertStatus: "SUBMITTED" }, "NOT_APPROVED"],
    [{ expertStatus: "UNDER_REVIEW" }, "NOT_APPROVED"],
    [{ expertStatus: "REJECTED" }, "NOT_APPROVED"],
    [{ expertStatus: "SUSPENDED" }, "NOT_APPROVED"],
    [{ accountStatus: "SUSPENDED" }, "ACCOUNT_NOT_ACTIVE"],
    [{ availabilityStatus: "OFFLINE" }, "NOT_AVAILABLE"],
    [{ availabilityStatus: "ON_OFFER" }, "ALREADY_ON_OFFER"],
    [{ availabilityStatus: "IN_SESSION" }, "IN_SESSION"],
    [{ lastHeartbeatAt: null }, "PRESENCE_STALE"],
    [{ alreadyResponded: true }, "ALREADY_RESPONDED"],
    [{ isRequestingCustomer: true }, "IS_THE_CUSTOMER"],
  ];

  for (const [overrides, reason] of blocked) {
    it(`excludes with ${reason}`, () => {
      const outcome = applyFilters({
        candidate: able,
        eligibility: eligible(overrides),
        context: context(0, { required: need }),
      });
      expect(outcome.passed).toBe(false);
      expect(outcome.reasons).toContain(reason);
    });
  }

  it("excludes a stale heartbeat even while AVAILABLE", () => {
    const outcome = applyFilters({
      candidate: able,
      eligibility: eligible({ lastHeartbeatAt: new Date(NOW.getTime() - 200_000) }),
      context: context(0, { required: need }),
    });
    expect(outcome.reasons).toContain("PRESENCE_STALE");
  });

  it("admits a heartbeat inside the window", () => {
    const outcome = applyFilters({
      candidate: able,
      eligibility: eligible({ lastHeartbeatAt: new Date(NOW.getTime() - 60_000) }),
      context: context(0, { required: need }),
    });
    expect(outcome.passed).toBe(true);
  });

  it("collects every failing reason rather than stopping at the first", () => {
    // Requirement 4: an answer that names one problem when there were three is
    // a misleading answer.
    const outcome = applyFilters({
      candidate: candidate({ id: "E", skills: { apex: "BEGINNER" } }),
      eligibility: eligible({ expertStatus: "SUSPENDED", availabilityStatus: "OFFLINE" }),
      context: context(0, { required: need }),
    });
    expect(outcome.reasons).toContain("NOT_APPROVED");
    expect(outcome.reasons).toContain("NOT_AVAILABLE");
    expect(outcome.reasons).toContain("PRIMARY_BELOW_FLOOR");
    expect(outcome.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it("has human-readable copy for every reason code", () => {
    for (const reason of Object.keys(EXCLUSION_COPY)) {
      expect(EXCLUSION_COPY[reason as keyof typeof EXCLUSION_COPY].length).toBeGreaterThan(10);
    }
  });
});

// ── Stage 2, the other gates ─────────────────────────────────────────────────

describe("secondary skills rank, they do not gate", () => {
  const need = required(["apex", true], ["triggers", false], ["batch-apex", false]);

  /**
   * The Phase 6 decision, as the test that pins it.
   *
   * Secondary-skill alignment is a ranking signal, not an eligibility one. It
   * lives in `skillScore` — see `scoring.test.ts` and the assertions below — and
   * `secondaryCoverage` is 0 at every level.
   *
   * Twice before, this was a hard gate and twice it excluded the right person:
   * at 1.0 nobody matched at level 0 at all, and at 0.25 an expert holding
   * `apex: ADVANCED` was made to wait 180 seconds for a batch-Apex request
   * because they had not separately declared `batch-apex`. The taxonomy is
   * finer-grained than expertise is.
   */
  it("admits an expert who covers none of the supporting skills, at every level", () => {
    const bare = candidate({ id: "bare", skills: { apex: "EXPERT" } });
    for (let level = 0; level <= MAX_RELAXATION_LEVEL; level++) {
      const outcome = applyFilters({
        candidate: bare,
        eligibility: eligible(),
        context: context(level, { required: need }),
      });
      expect(outcome.passed, `level ${level}`).toBe(true);
      expect(outcome.reasons).toEqual([]);
    }
  });

  it("keeps the coverage lever at zero on every rung", () => {
    // A guard against quietly re-enabling it. If someone raises this, they should
    // have to change this test and read why it is here.
    for (let level = 0; level <= MAX_RELAXATION_LEVEL; level++) {
      expect(ruleForLevel(level).secondaryCoverage, `level ${level}`).toBe(0);
    }
  });

  it("still ranks fuller coverage above narrower coverage", () => {
    // The other half of the decision: removing the gate must not remove the
    // signal. Same primary level, so the band is equal and the score decides.
    const complete = candidate({
      id: "complete",
      skills: { apex: ["ADVANCED", 5], triggers: ["ADVANCED", 5], "batch-apex": ["ADVANCED", 5] },
      idleMinutes: 60,
    });
    const narrow = candidate({
      id: "narrow",
      skills: { apex: ["ADVANCED", 5] },
      idleMinutes: 60,
    });

    const wide = scoreCandidate({
      required: need,
      candidate: complete,
      weights: DEFAULT_WEIGHTS,
      thresholds: THRESHOLDS,
      allowCategorySubstitute: false,
    });
    const thin = scoreCandidate({
      required: need,
      candidate: narrow,
      weights: DEFAULT_WEIGHTS,
      thresholds: THRESHOLDS,
      allowCategorySubstitute: false,
    });

    expect(wide.skillScore).toBeGreaterThan(thin.skillScore);
    expect(wide.finalScore).toBeGreaterThan(thin.finalScore);
    // Same band — the difference is entirely the score, which is the point.
    expect(wide.breakdown.primaryBand).toBe(thin.breakdown.primaryBand);
  });

  it("counts an uncovered secondary as zero in the score, not as an exclusion", () => {
    const narrow = candidate({ id: "n", skills: { apex: ["ADVANCED", 5] } });
    const score = scoreCandidate({
      required: need,
      candidate: narrow,
      weights: DEFAULT_WEIGHTS,
      thresholds: THRESHOLDS,
      allowCategorySubstitute: false,
    });
    const missing = score.breakdown.perSkill.filter((s) => s.proficiencyLevel === null);
    expect(missing).toHaveLength(2);
    expect(missing.every((s) => s.value === 0)).toBe(true);
  });

  it("lets a category sibling raise the score at level 3, and only there", () => {
    // `widenSecondaryToCategory` still does something now that coverage is off:
    // at maximum relaxation a related skill stands in when *scoring*.
    const sibling = candidate({
      id: "sibling",
      skills: {
        apex: ["ADVANCED", 5],
        "queueable-apex": { level: "ADVANCED", years: 5, category: "cat_devops" },
      },
    });
    const scoreAt = (level: number) =>
      scoreCandidate({
        required: need,
        candidate: sibling,
        weights: DEFAULT_WEIGHTS,
        thresholds: THRESHOLDS,
        allowCategorySubstitute: ruleForLevel(level).widenSecondaryToCategory,
      }).skillScore;

    expect(scoreAt(3)).toBeGreaterThan(scoreAt(0));
    expect(scoreAt(0)).toBe(scoreAt(2));
  });
});

describe("the rating floor", () => {
  const need = required(["apex", true]);
  // 25 over 10 ratings is 2.5 raw, which shrinks to 3.167 — below the 3.5 floor.
  // Worth knowing how strong the shrinkage is: a genuine 3.0 average over ten
  // ratings lands on exactly 3.5 and passes, because with that few ratings the
  // prior still carries a third of the weight.
  const poorlyRated = candidate({
    id: "I",
    skills: { apex: "EXPERT" },
    ratingSum: 25,
    ratingCount: 10,
  });

  it("excludes below the minimum at level 0", () => {
    expect(
      applyFilters({
        candidate: poorlyRated,
        eligibility: eligible(),
        context: context(0, { required: need }),
      }).reasons,
    ).toContain("RATING_BELOW_FLOOR");
  });

  it("is relaxed away at level 1", () => {
    expect(
      applyFilters({
        candidate: poorlyRated,
        eligibility: eligible(),
        context: context(1, { required: need }),
      }).passed,
    ).toBe(true);
  });

  it("is waived for an expert with too few ratings to judge", () => {
    // Two bad ratings is not a bad expert, it is an unproven one.
    const newcomer = candidate({
      id: "J",
      skills: { apex: "EXPERT" },
      ratingSum: 4,
      ratingCount: 2,
    });
    expect(
      applyFilters({
        candidate: newcomer,
        eligibility: eligible(),
        context: context(0, { required: need }),
      }).passed,
    ).toBe(true);
  });

  it("is not a permanent exclusion — relaxation clears it", () => {
    expect(
      applyFilters({
        candidate: poorlyRated,
        eligibility: eligible(),
        context: context(0, { required: need }),
      }).permanent,
    ).toBe(false);
  });
});

describe("language", () => {
  const need = required(["apex", true]);

  it("excludes with no overlap at level 0", () => {
    const englishOnly = candidate({ id: "K", skills: { apex: "EXPERT" }, languages: ["en"] });
    expect(
      applyFilters({
        candidate: englishOnly,
        eligibility: eligible(),
        context: context(0, { required: need, customerLanguages: ["ja"] }),
      }).reasons,
    ).toContain("NO_LANGUAGE_OVERLAP");
  });

  it("is dropped at level 2", () => {
    const englishOnly = candidate({ id: "L", skills: { apex: "EXPERT" }, languages: ["en"] });
    expect(
      applyFilters({
        candidate: englishOnly,
        eligibility: eligible(),
        context: context(2, { required: need, customerLanguages: ["ja"] }),
      }).passed,
    ).toBe(true);
  });

  it("is not applied when the customer stated none", () => {
    const englishOnly = candidate({ id: "M", skills: { apex: "EXPERT" }, languages: ["en"] });
    expect(
      applyFilters({
        candidate: englishOnly,
        eligibility: eligible(),
        context: context(0, { required: need, customerLanguages: [] }),
      }).passed,
    ).toBe(true);
  });
});

describe("the primary floor across every proficiency and level", () => {
  const need = required(["cpq", true]);
  const expectations: Record<ProficiencyLevel, number[]> = {
    // The relaxation levels at which this proficiency is admitted.
    BEGINNER: [],
    INTERMEDIATE: [2, 3],
    ADVANCED: [0, 1, 2, 3],
    EXPERT: [0, 1, 2, 3],
  };

  for (const level of PROFICIENCY_ORDER) {
    for (let relaxation = 0; relaxation <= MAX_RELAXATION_LEVEL; relaxation++) {
      const shouldPass = expectations[level].includes(relaxation);
      it(`${level} at relaxation ${relaxation} → ${shouldPass ? "admitted" : "excluded"}`, () => {
        const person = candidate({ id: `${level}-${relaxation}`, skills: { cpq: level } });
        expect(
          applyFilters({
            candidate: person,
            eligibility: eligible(),
            context: context(relaxation, { required: need }),
          }).passed,
        ).toBe(shouldPass);
      });
    }
  }
});

describe("expert status coverage", () => {
  it("admits only APPROVED", () => {
    const need = required(["apex", true]);
    const able = candidate({ id: "N", skills: { apex: "EXPERT" } });
    const statuses: ExpertStatus[] = [
      "DRAFT",
      "SUBMITTED",
      "UNDER_REVIEW",
      "APPROVED",
      "REJECTED",
      "SUSPENDED",
    ];
    const admitted = statuses.filter(
      (expertStatus) =>
        applyFilters({
          candidate: able,
          eligibility: eligible({ expertStatus }),
          context: context(0, { required: need }),
        }).passed,
    );
    expect(admitted).toEqual(["APPROVED"]);
  });
});
