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
  floorForLevel,
  MAX_RELAXATION_LEVEL,
  RELAXATION_LADDER,
  ruleForLevel,
  scheduledLevel,
} from "./relaxation.js";
import { DEFAULT_SCORING_THRESHOLDS } from "./scoring.js";

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

  it("engages levels on the documented schedule", () => {
    expect(scheduledLevel(0)).toBe(0);
    expect(scheduledLevel(3.9)).toBe(0);
    expect(scheduledLevel(4)).toBe(1);
    expect(scheduledLevel(8)).toBe(2);
    expect(scheduledLevel(12)).toBe(3);
    expect(scheduledLevel(14.9)).toBe(3);
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

describe("secondary-skill coverage", () => {
  const need = required(["apex", true], ["triggers", false], ["batch-apex", false]);

  /**
   * The shape a real classified request actually has, as a regression test.
   *
   * One primary and three supporting skills, and an expert who is EXPERT at the
   * primary and holds exactly one of the three. Level 0 must admit them.
   *
   * This is the case that broke: coverage started at 1.0, so nobody matched at
   * level 0 and every request waited four minutes to relax. The unit tests all
   * used two-skill requests and never saw it — the end-to-end run did.
   */
  it("admits a strong specialist who covers only one of three supporting skills", () => {
    const realWorld = required(
      ["apex", true],
      ["triggers", false],
      ["soql-sosl", false],
      ["governor-limits", false],
    );
    const specialist = candidate({
      id: "real",
      skills: { apex: ["EXPERT", 8], triggers: ["ADVANCED", 7] },
    });
    const outcome = applyFilters({
      candidate: specialist,
      eligibility: eligible(),
      context: context(0, { required: realWorld }),
    });
    expect(outcome.passed).toBe(true);
    expect(outcome.reasons).toEqual([]);
  });

  it("still excludes someone who covers none of the supporting skills at level 0", () => {
    const bare = candidate({ id: "F", skills: { apex: "EXPERT" } });
    expect(
      applyFilters({
        candidate: bare,
        eligibility: eligible(),
        context: context(0, { required: need }),
      }).reasons,
    ).toContain("INSUFFICIENT_SECONDARY_COVERAGE");
  });

  it("admits half coverage at level 0 — the score, not the filter, rewards more", () => {
    const partial = candidate({ id: "G", skills: { apex: "EXPERT", triggers: "ADVANCED" } });
    expect(
      applyFilters({
        candidate: partial,
        eligibility: eligible(),
        context: context(0, { required: need }),
      }).passed,
    ).toBe(true);
  });

  it("stops asking for secondaries entirely by level 2", () => {
    const bare = candidate({ id: "H0", skills: { apex: "EXPERT" } });
    expect(
      applyFilters({
        candidate: bare,
        eligibility: eligible(),
        context: context(2, { required: need }),
      }).passed,
    ).toBe(true);
  });

  it("counts a category sibling toward coverage at level 3 only", () => {
    // Four secondaries so a third of them is more than one, making the
    // substitution observable rather than masked by the low threshold.
    const wide = required(
      ["apex", true],
      ["triggers", false],
      ["batch-apex", false],
      ["platform-events", false],
    );
    const sibling = candidate({
      id: "H",
      skills: {
        apex: "EXPERT",
        "queueable-apex": { level: "ADVANCED", category: "cat_devops" },
      },
    });
    expect(
      applyFilters({
        candidate: sibling,
        eligibility: eligible(),
        context: context(0, { required: wide }),
      }).reasons,
    ).toContain("INSUFFICIENT_SECONDARY_COVERAGE");
    // At level 3 the sibling stands in, so coverage is met.
    expect(
      applyFilters({
        candidate: sibling,
        eligibility: eligible(),
        context: context(3, { required: wide }),
      }).passed,
    ).toBe(true);
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
