import type { ExpertStatus } from "@sfx/contracts";
import { describe, expect, it } from "vitest";
import { IllegalTransitionError } from "../shared/errors.js";
import {
  assertExpertTransition,
  canTransitionExpert,
  EXPERT_TRANSITIONS,
  isEligibleForMatching,
  isPendingReview,
  missingForSubmission,
  nextExpertStatuses,
} from "./expert-status.js";

const ALL: ExpertStatus[] = [
  "DRAFT",
  "SUBMITTED",
  "UNDER_REVIEW",
  "APPROVED",
  "REJECTED",
  "SUSPENDED",
];

describe("requirement 2 — eligibility is APPROVED and nothing else", () => {
  it("is true only for APPROVED", () => {
    for (const status of ALL) {
      expect(isEligibleForMatching(status), status).toBe(status === "APPROVED");
    }
  });

  it("is false for a user with no application at all", () => {
    // A user holding the EXPERT role with no profile must not slip through as
    // eligible on a null/undefined status.
    expect(isEligibleForMatching(undefined)).toBe(false);
    expect(isEligibleForMatching(null)).toBe(false);
  });

  it("takes a status, not an actor, so roles cannot influence the answer", () => {
    // Structural guarantee: there is no parameter through which a role could be
    // passed, so no future caller can accidentally make a role count.
    expect(isEligibleForMatching.length).toBe(1);
  });
});

describe("lifecycle structure", () => {
  it("has no duplicate transitions", () => {
    const pairs = EXPERT_TRANSITIONS.map((r) => `${r.from}→${r.to}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it("lets an applicant reach SUBMITTED and no further", () => {
    expect(nextExpertStatuses("DRAFT", "EXPERT")).toEqual(["SUBMITTED"]);
    // The decisive step is never the applicant's.
    expect(nextExpertStatuses("SUBMITTED", "EXPERT")).toEqual([]);
  });

  it("never lets an applicant approve themselves", () => {
    for (const from of ALL) {
      expect(nextExpertStatuses(from, "EXPERT")).not.toContain("APPROVED");
    }
  });

  it("never lets a customer touch the lifecycle", () => {
    for (const from of ALL) {
      expect(nextExpertStatuses(from, "CUSTOMER")).toEqual([]);
    }
  });

  it("makes rejection recoverable", () => {
    expect(canTransitionExpert("REJECTED", "DRAFT", "EXPERT")).toBe(true);
  });

  it("allows suspend and reinstate, both admin-only", () => {
    expect(canTransitionExpert("APPROVED", "SUSPENDED", "ADMIN")).toBe(true);
    expect(canTransitionExpert("SUSPENDED", "APPROVED", "ADMIN")).toBe(true);
    expect(canTransitionExpert("APPROVED", "SUSPENDED", "EXPERT")).toBe(false);
  });

  it("does not allow jumping straight from DRAFT to APPROVED", () => {
    expect(canTransitionExpert("DRAFT", "APPROVED", "ADMIN")).toBe(false);
  });

  it("flags the reviewable statuses", () => {
    expect(isPendingReview("SUBMITTED")).toBe(true);
    expect(isPendingReview("UNDER_REVIEW")).toBe(true);
    expect(isPendingReview("APPROVED")).toBe(false);
  });
});

describe("requirement 3 — consequential decisions demand a reason", () => {
  it("requires one for every status change that alters the outcome", () => {
    const consequential: Array<[ExpertStatus, ExpertStatus]> = [
      ["SUBMITTED", "APPROVED"],
      ["SUBMITTED", "REJECTED"],
      ["UNDER_REVIEW", "APPROVED"],
      ["UNDER_REVIEW", "REJECTED"],
      ["APPROVED", "SUSPENDED"],
      ["SUSPENDED", "APPROVED"],
    ];
    for (const [from, to] of consequential) {
      const rule = EXPERT_TRANSITIONS.find((r) => r.from === from && r.to === to);
      expect(rule?.requiresReason, `${from} → ${to}`).toBe(true);
    }
  });

  it("does not demand one merely to claim an application", () => {
    const claim = EXPERT_TRANSITIONS.find((r) => r.from === "SUBMITTED" && r.to === "UNDER_REVIEW");
    expect(claim?.requiresReason).toBe(false);
  });
});

describe("assertExpertTransition", () => {
  it("rejects an illegal move and reports what was legal", () => {
    try {
      assertExpertTransition("DRAFT", "APPROVED", "ADMIN");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalTransitionError);
      expect((error as Error).message).toContain("SUBMITTED");
    }
  });

  it("rejects a legal move by the wrong actor", () => {
    expect(() => assertExpertTransition("SUBMITTED", "APPROVED", "EXPERT")).toThrow(
      IllegalTransitionError,
    );
  });
});

describe("submission completeness", () => {
  const complete = {
    country: "IN",
    timezone: "Asia/Kolkata",
    yearsExperience: 7,
    professionalSummary: "Apex and LWC.",
    termsAcceptedAt: new Date(),
    confidentialityAcceptedAt: new Date(),
  };

  it("passes a complete application", () => {
    expect(missingForSubmission(complete)).toEqual([]);
  });

  it("reports every missing field at once, not just the first", () => {
    // One round trip should tell the applicant everything still outstanding.
    expect(missingForSubmission({})).toHaveLength(6);
  });

  it("treats an empty string as missing", () => {
    expect(missingForSubmission({ ...complete, professionalSummary: "" })).toEqual([
      "professionalSummary",
    ]);
  });

  it("treats zero years of experience as answered", () => {
    // 0 is a legitimate answer; a falsy check here would silently block someone.
    expect(missingForSubmission({ ...complete, yearsExperience: 0 })).toEqual([]);
  });

  it("requires both acceptances", () => {
    expect(missingForSubmission({ ...complete, termsAcceptedAt: null })).toEqual([
      "termsAcceptedAt",
    ]);
    expect(missingForSubmission({ ...complete, confidentialityAcceptedAt: null })).toEqual([
      "confidentialityAcceptedAt",
    ]);
  });
});
