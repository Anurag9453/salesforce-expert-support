import { beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../authorization/index.js";
import { FixedClock } from "../ports/clock.js";
import { ForbiddenError, ValidationError } from "../shared/errors.js";
import { ExpertAdminService } from "./expert-admin-service.js";
import { ExpertApplicationService } from "./expert-application-service.js";
import { isEligibleForMatching } from "./expert-status.js";
import { InMemoryUnitOfWork } from "./in-memory-uow.js";

/**
 * The Phase 2 exit criterion, as tests:
 * an expert can be created, submitted, approved by an admin — and is eligible
 * for matching at no point before that.
 */

const COMPLETE_DRAFT = {
  country: "IN",
  timezone: "Asia/Kolkata",
  yearsExperience: 7,
  professionalSummary: "Apex, LWC and integration work across ten Salesforce orgs.",
  // Vetting fields. Required at submission because the platform sends this
  // person to a customer: `phone` is how we reach them when something goes
  // wrong, and the Trailhead profile is the one claim a reviewer can check.
  phone: "+91 98765 43210",
  trailheadUrl: "https://www.salesforce.com/trailblazer/priyaraghavan",
  acceptTerms: true,
  acceptConfidentiality: true,
};

let uow: InMemoryUnitOfWork;
let clock: FixedClock;
let applications: ExpertApplicationService;
let admin: ExpertAdminService;

function actorFor(userId: string, overrides: Partial<Actor> = {}): Actor {
  const user = uow.userRows.get(userId);
  if (!user) throw new Error(`seed ${userId} first`);
  const application = [...uow.applicationRows.values()].find((a) => a.userId === userId);
  return {
    userId: user.id,
    email: user.email,
    roles: user.roles,
    status: user.status,
    // Verified by default: these tests are about the review lifecycle, and an
    // unverified email is its own test rather than a precondition of every one.
    emailVerified: true,
    ...(application ? { expert: { profileId: application.id, status: application.status } } : {}),
    ...overrides,
  };
}

beforeEach(() => {
  uow = new InMemoryUnitOfWork();
  clock = new FixedClock(new Date("2026-08-02T10:00:00Z"));
  applications = new ExpertApplicationService(uow, clock);
  admin = new ExpertAdminService(uow, clock);
  uow.seedUser({ id: "customer_1", roles: ["CUSTOMER"] });
  uow.seedUser({ id: "admin_1", roles: ["CUSTOMER", "ADMIN"], email: "admin@example.com" });
});

describe("the Phase 2 acceptance flow", () => {
  it("runs create → submit → approve, and only then is the expert eligible", async () => {
    // 1. An existing customer applies.
    const created = await applications.start(actorFor("customer_1"));
    expect(created.status).toBe("DRAFT");
    expect(isEligibleForMatching(created.status)).toBe(false);

    // Requirement 1: same account, now dual-role. No second identity.
    expect(uow.userRows.get("customer_1")?.roles).toEqual(["CUSTOMER", "EXPERT"]);
    expect(uow.userRows.size).toBe(2); // customer_1 and admin_1 — nobody new

    // 2. Fill in and submit.
    await applications.saveDraft(actorFor("customer_1"), COMPLETE_DRAFT);
    const submitted = await applications.submit(actorFor("customer_1"));
    expect(submitted.status).toBe("SUBMITTED");
    expect(submitted.submittedAt).toEqual(clock.now());
    expect(isEligibleForMatching(submitted.status)).toBe(false);

    // 3. Admin reviews and approves.
    const claimed = await admin.claimForReview(actorFor("admin_1"), created.id);
    expect(claimed.status).toBe("UNDER_REVIEW");
    expect(isEligibleForMatching(claimed.status)).toBe(false);

    const approved = await admin.approve(actorFor("admin_1"), created.id, "Strong Apex depth.");
    expect(approved.status).toBe("APPROVED");
    expect(isEligibleForMatching(approved.status)).toBe(true);
  });

  it("keeps the applicant ineligible at every step before approval", async () => {
    const created = await applications.start(actorFor("customer_1"));
    const seen: boolean[] = [isEligibleForMatching(created.status)];

    await applications.saveDraft(actorFor("customer_1"), COMPLETE_DRAFT);
    seen.push(isEligibleForMatching((await applications.getOwn(actorFor("customer_1"))).status));

    const submitted = await applications.submit(actorFor("customer_1"));
    seen.push(isEligibleForMatching(submitted.status));

    const claimed = await admin.claimForReview(actorFor("admin_1"), created.id);
    seen.push(isEligibleForMatching(claimed.status));

    expect(seen).toEqual([false, false, false, false]);
  });
});

describe("requirement 1 — dual role, one identity", () => {
  it("is idempotent when someone applies twice", async () => {
    const first = await applications.start(actorFor("customer_1"));
    // Second call with a fresh actor — what a double-click actually produces.
    const second = await applications.start(actorFor("customer_1"));
    expect(second.id).toBe(first.id);
    expect(uow.applicationRows.size).toBe(1);
    expect(uow.userRows.get("customer_1")?.roles).toEqual(["CUSTOMER", "EXPERT"]);
  });

  it("is idempotent under a race, where both callers saw no application", async () => {
    // Both requests built their Actor before either committed, so neither knows
    // an application exists. This is the case the service guard exists for.
    const stale = actorFor("customer_1");
    const [a, b] = await Promise.all([applications.start(stale), applications.start(stale)]);
    expect(a.id).toBe(b.id);
    expect(uow.applicationRows.size).toBe(1);
  });

  it("does not remove the customer role when the expert role is added", async () => {
    await applications.start(actorFor("customer_1"));
    expect(uow.userRows.get("customer_1")?.roles).toContain("CUSTOMER");
  });
});

describe("vetting — we must be able to reach the person we approve", () => {
  it("refuses to submit an application from an unverified email", async () => {
    await applications.start(actorFor("customer_1"));
    await applications.saveDraft(actorFor("customer_1"), COMPLETE_DRAFT);

    // Everything else about the application is complete. The only thing wrong
    // is that nobody has proved the address exists.
    await expect(
      applications.submit(actorFor("customer_1", { emailVerified: false })),
    ).rejects.toThrow(/Confirm your email address/);
  });

  it("lets the same application through once the address is confirmed", async () => {
    await applications.start(actorFor("customer_1"));
    await applications.saveDraft(actorFor("customer_1"), COMPLETE_DRAFT);

    const submitted = await applications.submit(actorFor("customer_1"));
    expect(submitted.status).toBe("SUBMITTED");
  });

  it("records what a reviewer verified, apart from what the applicant claimed", async () => {
    await applications.start(actorFor("customer_1"));
    await applications.saveDraft(actorFor("customer_1"), {
      ...COMPLETE_DRAFT,
      certifications: ["Certified Technical Architect", "Certified Application Architect"],
    });
    const submitted = await applications.submit(actorFor("customer_1"));

    // The reviewer confirmed only one of the two claims.
    const approved = await admin.approve(actorFor("admin_1"), submitted.id, "Checked Trailhead.", [
      "Certified Application Architect",
    ]);

    expect(approved.certifications).toEqual([
      "Certified Technical Architect",
      "Certified Application Architect",
    ]);
    expect(approved.verifiedCertifications).toEqual(["Certified Application Architect"]);
    expect(approved.certificationsVerifiedBy).toBe("admin_1");
    expect(approved.certificationsVerifiedAt).not.toBeNull();
  });
});

describe("requirement 2 — approval is the only route to eligibility", () => {
  it("suspension revokes eligibility immediately", async () => {
    const created = await applications.start(actorFor("customer_1"));
    await applications.saveDraft(actorFor("customer_1"), COMPLETE_DRAFT);
    await applications.submit(actorFor("customer_1"));
    await admin.approve(actorFor("admin_1"), created.id, "ok");

    const suspended = await admin.suspend(actorFor("admin_1"), created.id, "Quality concerns.");
    expect(suspended.status).toBe("SUSPENDED");
    expect(isEligibleForMatching(suspended.status)).toBe(false);

    const reinstated = await admin.reinstate(actorFor("admin_1"), created.id, "Resolved.");
    expect(isEligibleForMatching(reinstated.status)).toBe(true);
  });

  it("refuses to submit an incomplete application, listing everything missing", async () => {
    await applications.start(actorFor("customer_1"));
    await applications.saveDraft(actorFor("customer_1"), { country: "IN" });

    await expect(applications.submit(actorFor("customer_1"))).rejects.toThrow(ValidationError);
    try {
      await applications.submit(actorFor("customer_1"));
    } catch (error) {
      const fields = Object.keys((error as ValidationError).fields);
      expect(fields).toContain("professionalSummary");
      expect(fields).toContain("termsAcceptedAt");
      expect(fields).not.toContain("country");
    }
  });
});

describe("requirement 3 — every admin decision is audited", () => {
  async function approvedApplication() {
    const created = await applications.start(actorFor("customer_1"));
    await applications.saveDraft(actorFor("customer_1"), COMPLETE_DRAFT);
    await applications.submit(actorFor("customer_1"));
    return created;
  }

  it("records who, when, and the transition", async () => {
    const created = await approvedApplication();
    clock.advanceBy(60_000);
    await admin.approve(actorFor("admin_1"), created.id, "Strong Apex depth.");

    const history = await admin.history(actorFor("admin_1"), created.id);
    const approval = history.find((e) => e.action === "expert.approved");

    expect(approval).toBeDefined();
    expect(approval?.actorUserId).toBe("admin_1");
    expect(approval?.actorType).toBe("ADMIN");
    expect(approval?.before).toMatchObject({ status: "SUBMITTED" });
    expect(approval?.after).toMatchObject({
      status: "APPROVED",
      reviewedByUserId: "admin_1",
      reviewedByEmail: "admin@example.com",
      notes: "Strong Apex depth.",
    });
  });

  it("builds a complete lifecycle history", async () => {
    const created = await approvedApplication();
    await admin.claimForReview(actorFor("admin_1"), created.id);
    await admin.approve(actorFor("admin_1"), created.id, "ok");
    await admin.suspend(actorFor("admin_1"), created.id, "concerns");
    await admin.reinstate(actorFor("admin_1"), created.id, "resolved");

    const actions = (await admin.history(actorFor("admin_1"), created.id)).map((e) => e.action);
    expect(actions).toEqual([
      "expert.reinstated",
      "expert.suspended",
      "expert.approved",
      "expert.claimed",
      "expert_application.submitted",
      "expert_application.started",
    ]);
  });

  it("rejects a decision with no reason", async () => {
    const created = await approvedApplication();
    await expect(admin.approve(actorFor("admin_1"), created.id, "   ")).rejects.toThrow(
      ValidationError,
    );
    // And leaves the status untouched.
    expect(uow.applicationRows.get(created.id)?.status).toBe("SUBMITTED");
  });

  it("never leaves a status change without its audit row", async () => {
    // If the commit fails after both writes, neither survives.
    const created = await approvedApplication();
    const auditBefore = uow.auditEntries.length;
    uow.failCommit = true;

    await expect(admin.approve(actorFor("admin_1"), created.id, "ok")).rejects.toThrow();

    expect(uow.applicationRows.get(created.id)?.status).toBe("SUBMITTED");
    expect(uow.auditEntries.length).toBe(auditBefore);
  });
});

describe("requirement 4 — authorization is enforced in the service, not the UI", () => {
  it("stops a non-admin approving an application", async () => {
    const created = await applications.start(actorFor("customer_1"));
    await applications.saveDraft(actorFor("customer_1"), COMPLETE_DRAFT);
    await applications.submit(actorFor("customer_1"));

    // The applicant calls the admin service directly, as a hostile client would.
    await expect(
      admin.approve(actorFor("customer_1"), created.id, "approving myself"),
    ).rejects.toThrow(ForbiddenError);
    expect(uow.applicationRows.get(created.id)?.status).toBe("SUBMITTED");
  });

  it("stops a non-admin reading the review queue", async () => {
    await expect(admin.listPendingReview(actorFor("customer_1"))).rejects.toThrow(ForbiddenError);
  });

  it("stops a suspended admin from acting", async () => {
    const created = await applications.start(actorFor("customer_1"));
    await applications.saveDraft(actorFor("customer_1"), COMPLETE_DRAFT);
    await applications.submit(actorFor("customer_1"));

    const suspendedAdmin = actorFor("admin_1", { status: "SUSPENDED" });
    await expect(admin.approve(suspendedAdmin, created.id, "ok")).rejects.toThrow(ForbiddenError);
  });

  it("stops an applicant editing once the application is with an admin", async () => {
    await applications.start(actorFor("customer_1"));
    await applications.saveDraft(actorFor("customer_1"), COMPLETE_DRAFT);
    await applications.submit(actorFor("customer_1"));

    await expect(
      applications.saveDraft(actorFor("customer_1"), { professionalSummary: "sneaky edit" }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("rejection is recoverable", () => {
  it("reopens to DRAFT on the next edit, and can be resubmitted", async () => {
    const created = await applications.start(actorFor("customer_1"));
    await applications.saveDraft(actorFor("customer_1"), COMPLETE_DRAFT);
    await applications.submit(actorFor("customer_1"));
    await admin.reject(actorFor("admin_1"), created.id, "Needs more integration depth.");

    const reworked = await applications.saveDraft(actorFor("customer_1"), {
      professionalSummary: "Expanded detail on MuleSoft and integration patterns across orgs.",
    });
    expect(reworked.status).toBe("DRAFT");

    const resubmitted = await applications.submit(actorFor("customer_1"));
    expect(resubmitted.status).toBe("SUBMITTED");
  });
});
