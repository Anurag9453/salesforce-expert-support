import { describe, expect, it } from "vitest";
import {
  adminVerifySkillSchema,
  declareSkillSchema,
  setAvailabilitySchema,
  updateExpertProfileSchema,
} from "./expert-workspace.js";

/**
 * The wire-level half of requirements 2 and 8.
 *
 * These are the *outer* barrier, not the guarantee. The domain filters and
 * re-checks everything below, and those tests are the ones that hold if a second
 * transport is added. What is asserted here is that a hostile payload is
 * **refused** rather than quietly cleaned up — a client trying to set `verified`
 * should be told no, not left believing it worked.
 */

describe("declareSkillSchema — requirement 2", () => {
  const valid = { skillSlug: "apex", proficiencyLevel: "ADVANCED", yearsExperience: 4 };

  it("accepts skill, proficiency and years-with-this-skill", () => {
    const parsed = declareSkillSchema.parse(valid);
    expect(parsed).toEqual(valid);
  });

  it("has no field an expert could use to verify themselves", () => {
    // The claim is structural: `verified` is not in the shape at all, so no
    // handler can forward one and no future handler can start to.
    expect(Object.keys(declareSkillSchema.shape)).toEqual([
      "skillSlug",
      "proficiencyLevel",
      "yearsExperience",
    ]);
  });

  it("drops a `verified` key rather than honouring it", () => {
    const parsed = declareSkillSchema.parse({ ...valid, verified: true, verifiedAt: "2026-01-01" });
    expect(parsed).not.toHaveProperty("verified");
    expect(parsed).not.toHaveProperty("verifiedAt");
  });

  it("treats zero years as a real answer", () => {
    // Six months of CPQ is an honest claim. Forcing a minimum of one year would
    // push people to round up.
    expect(declareSkillSchema.parse({ ...valid, yearsExperience: 0 }).yearsExperience).toBe(0);
  });

  it("rejects negative and absurd year counts", () => {
    expect(declareSkillSchema.safeParse({ ...valid, yearsExperience: -1 }).success).toBe(false);
    expect(declareSkillSchema.safeParse({ ...valid, yearsExperience: 41 }).success).toBe(false);
  });

  it("rejects a proficiency level outside the enum", () => {
    expect(declareSkillSchema.safeParse({ ...valid, proficiencyLevel: "GURU" }).success).toBe(
      false,
    );
  });

  it("coerces the years value a form submits as a string", () => {
    expect(declareSkillSchema.parse({ ...valid, yearsExperience: "7" }).yearsExperience).toBe(7);
  });
});

describe("adminVerifySkillSchema", () => {
  it("requires a reason", () => {
    expect(
      adminVerifySkillSchema.safeParse({ skillSlug: "apex", verified: true, notes: "" }).success,
    ).toBe(false);
    expect(
      adminVerifySkillSchema.safeParse({ skillSlug: "apex", verified: true, notes: "   " }).success,
    ).toBe(false);
  });

  it("accepts a verification with notes", () => {
    const parsed = adminVerifySkillSchema.parse({
      skillSlug: "apex",
      verified: true,
      notes: "Walked through a governor-limit refactor on a live org.",
    });
    expect(parsed.verified).toBe(true);
  });
});

describe("updateExpertProfileSchema — requirement 8", () => {
  it("accepts a partial edit", () => {
    // An ISO 3166-1 alpha-2 code, not a display name. Country and time zone are
    // picklists now, and a code is the only form the pair rule can check.
    const parsed = updateExpertProfileSchema.parse({ country: "IN" });
    expect(parsed).toEqual({ country: "IN" });
  });

  it("normalises a lowercase country code rather than rejecting it", () => {
    expect(updateExpertProfileSchema.parse({ country: "in" }).country).toBe("IN");
  });

  it("refuses a country name where a code belongs", () => {
    expect(updateExpertProfileSchema.safeParse({ country: "India" }).success).toBe(false);
  });

  it("refuses a time zone that is not the chosen country's", () => {
    const result = updateExpertProfileSchema.safeParse({
      country: "IN",
      timezone: "America/Los_Angeles",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // Reported against the field the expert would change, not the country.
      expect(result.error.issues[0]?.path).toEqual(["timezone"]);
    }
  });

  it("accepts a time zone that belongs to the chosen country", () => {
    const parsed = updateExpertProfileSchema.parse({ country: "IN", timezone: "Asia/Kolkata" });
    expect(parsed.timezone).toBe("Asia/Kolkata");
  });

  it("does not object when only one half of the pair is being edited", () => {
    // Changing just the zone is legitimate; the pair rule needs both to fire.
    expect(updateExpertProfileSchema.safeParse({ timezone: "America/New_York" }).success).toBe(
      true,
    );
  });

  it("refuses an administrative field outright rather than dropping it", () => {
    // `.strict()` over `.strip()` on purpose. A silently-ignored `status` looks
    // to the caller exactly like a successful privilege escalation.
    for (const field of [
      "status",
      "reviewNotes",
      "availabilityStatus",
      "lastHeartbeatAt",
      "sessionsCompleted",
      "payoutsEnabled",
      "verified",
    ]) {
      const result = updateExpertProfileSchema.safeParse({ country: "IN", [field]: "hijacked" });
      expect(result.success, `${field} should be rejected`).toBe(false);
    }
  });

  it("allows clearing an optional URL with an empty string", () => {
    expect(updateExpertProfileSchema.parse({ linkedinUrl: "" }).linkedinUrl).toBe("");
  });

  it("rejects a malformed URL", () => {
    expect(updateExpertProfileSchema.safeParse({ githubUrl: "not-a-url" }).success).toBe(false);
  });

  it("holds the summary to a real length", () => {
    expect(
      updateExpertProfileSchema.safeParse({ professionalSummary: "Salesforce." }).success,
    ).toBe(false);
  });
});

describe("setAvailabilitySchema", () => {
  it("carries a boolean and nothing else", () => {
    expect(setAvailabilitySchema.parse({ available: true })).toEqual({ available: true });
  });

  it("cannot be used to name a target status directly", () => {
    // The expert says on or off. ON_OFFER and IN_SESSION are the system's to
    // set, and there is no request shape that reaches them.
    const parsed = setAvailabilitySchema.parse({ available: true, status: "ON_OFFER" });
    expect(parsed).not.toHaveProperty("status");
  });

  it("rejects a missing or non-boolean flag", () => {
    expect(setAvailabilitySchema.safeParse({}).success).toBe(false);
    expect(setAvailabilitySchema.safeParse({ available: "yes" }).success).toBe(false);
  });
});
