import { describe, expect, it } from "vitest";
import {
  CERTIFICATION_HELP_OPTIONS,
  CERTIFICATION_OPTIONS,
  CERTIFICATION_TRACKS,
  CERTIFICATION_UNDECIDED,
  certificationSchema,
} from "./certifications.js";
import { createSupportLeadSchema } from "./requests.js";

/** Enough words to clear the description floor. */
const SUMMARY =
  "Sitting Platform Developer I in six weeks and the asynchronous Apex material is not sticking.";

const base = {
  name: "Meera Iyer",
  email: "meera@example.com",
  phone: "+919812345678",
  summary: SUMMARY,
};

describe("the certification catalogue", () => {
  it("has no duplicates across tracks", () => {
    /*
      Two tracks both claiming a credential would show it twice in one dropdown,
      which reads as a bug to whoever is choosing. Easy to introduce by hand,
      since several exams plausibly belong to more than one track.
    */
    const names = CERTIFICATION_TRACKS.flatMap((group) => group.certifications);
    expect(names.length).toBe(new Set(names).size);
  });

  it("keeps the undecided option out of the tracks and in the options", () => {
    // It belongs after every track in the list, not inside one of them.
    const inTracks = CERTIFICATION_TRACKS.flatMap((group) => group.certifications);
    expect(inTracks).not.toContain(CERTIFICATION_UNDECIDED);
    expect(CERTIFICATION_OPTIONS).toContain(CERTIFICATION_UNDECIDED);
  });

  it("has no empty track", () => {
    for (const group of CERTIFICATION_TRACKS) {
      expect(group.certifications.length).toBeGreaterThan(0);
    }
  });

  it("accepts every option it offers", () => {
    // The guard against a name that the form can produce and the schema rejects,
    // which would be a dead option nobody could get past.
    for (const option of CERTIFICATION_OPTIONS) {
      expect(certificationSchema.safeParse(option).success).toBe(true);
    }
  });

  it("rejects a credential that is not in the catalogue", () => {
    expect(certificationSchema.safeParse("Salesforce Certified Wizard").success).toBe(false);
  });
});

describe("a certification enquiry", () => {
  it("is accepted with a certification from the catalogue", () => {
    const result = createSupportLeadSchema.safeParse({
      ...base,
      supportType: "CERTIFICATION",
      certification: "Platform Developer II",
      certificationHelp: ["Weak topics"],
      examDate: "2026-09-12",
    });
    expect(result.success).toBe(true);
  });

  it("is rejected without one", () => {
    const result = createSupportLeadSchema.safeParse({
      ...base,
      supportType: "CERTIFICATION",
      certificationHelp: ["Study plan"],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain("certification");
  });

  it("does not require the long-term fields", () => {
    /*
      The refinement returns early per support type. Without that, a certification
      enquiry would be asked for a budget and an engagement length it was never
      shown fields for — the failure mode that makes a form impossible to submit
      with no visible reason why.
    */
    const result = createSupportLeadSchema.safeParse({
      ...base,
      supportType: "CERTIFICATION",
      certification: CERTIFICATION_UNDECIDED,
      certificationHelp: ["Study plan"],
    });
    expect(result.success).toBe(true);
  });

  it("does not let the other paths smuggle in a bad certification", () => {
    // Optional does not mean unvalidated: an instant enquiry may omit it, but if
    // it sends one it still has to be a real credential.
    const result = createSupportLeadSchema.safeParse({
      ...base,
      supportType: "INSTANT",
      certification: "Not a real exam",
    });
    expect(result.success).toBe(false);
  });
});

describe("the exam date and what help is wanted", () => {
  const certifying = {
    ...base,
    supportType: "CERTIFICATION" as const,
    certification: "Platform Administrator",
  };

  it("accepts an enquiry with no exam date", () => {
    // Plenty of people study before booking. Requiring a date would turn "not
    // yet" into a dead end on the one path where it is the normal answer.
    const result = createSupportLeadSchema.safeParse({
      ...certifying,
      certificationHelp: ["Study plan"],
    });
    expect(result.success).toBe(true);
    expect(result.data?.examDate).toBeUndefined();
  });

  it("rejects a date that is not a plain calendar day", () => {
    // A timestamp here would invite a zone conversion that moves the exam either
    // side of midnight.
    for (const examDate of ["12/09/2026", "2026-09-12T09:00:00Z", "September 12"]) {
      expect(
        createSupportLeadSchema.safeParse({
          ...certifying,
          certificationHelp: ["Study plan"],
          examDate,
        }).success,
      ).toBe(false);
    }
  });

  it("requires at least one kind of help", () => {
    for (const certificationHelp of [undefined, []]) {
      const result = createSupportLeadSchema.safeParse({ ...certifying, certificationHelp });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain(
        "certificationHelp",
      );
    }
  });

  it("accepts several, because these genuinely combine", () => {
    const result = createSupportLeadSchema.safeParse({
      ...certifying,
      certificationHelp: ["Study plan", "Retake after failing", "Mock exams"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts every option the form offers", () => {
    // The guard against a checkbox that cannot be submitted — which would look
    // like a broken form with no error to explain it.
    const result = createSupportLeadSchema.safeParse({
      ...certifying,
      certificationHelp: CERTIFICATION_HELP_OPTIONS.map((option) => option.value),
    });
    expect(result.success).toBe(true);
  });

  it("rejects a kind of help we do not offer", () => {
    const result = createSupportLeadSchema.safeParse({
      ...certifying,
      certificationHelp: ["Sit the exam for me"],
    });
    expect(result.success).toBe(false);
  });
});
