import type { ExpertStatus, UserRole } from "@sfx/contracts";
import { describe, expect, it } from "vitest";
import { ForbiddenError, UnauthenticatedError } from "../shared/errors.js";
import { ANONYMOUS, isDualRole, type Actor } from "./actor.js";
import { authorize, can, canAccessExpertWorkspace, grantedPermissions } from "./policy.js";

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: "user_1",
    email: "a@example.com",
    roles: ["CUSTOMER"],
    status: "ACTIVE",
    emailVerified: true,
    ...overrides,
  };
}

function withExpert(status: ExpertStatus, roles: UserRole[] = ["CUSTOMER", "EXPERT"]): Actor {
  return actor({ roles, expert: { profileId: "exp_1", status } });
}

describe("requirement 2 — the EXPERT role alone grants nothing", () => {
  it("denies workspace access to an EXPERT with no application", () => {
    // The pathological case: role granted, profile never created.
    expect(can(actor({ roles: ["CUSTOMER", "EXPERT"] }), "expert_workspace:access")).toBe(false);
  });

  const notApproved: ExpertStatus[] = [
    "DRAFT",
    "SUBMITTED",
    "UNDER_REVIEW",
    "REJECTED",
    "SUSPENDED",
  ];

  for (const status of notApproved) {
    it(`denies workspace access at status ${status}`, () => {
      expect(canAccessExpertWorkspace(withExpert(status))).toBe(false);
    });
  }

  it("grants workspace access only at APPROVED", () => {
    expect(canAccessExpertWorkspace(withExpert("APPROVED"))).toBe(true);
  });

  it("revokes access the moment an approved expert is suspended", () => {
    expect(canAccessExpertWorkspace(withExpert("APPROVED"))).toBe(true);
    expect(canAccessExpertWorkspace(withExpert("SUSPENDED"))).toBe(false);
  });

  it("does not let the ADMIN role stand in for an approved application", () => {
    // An admin administers experts; that is not the same as being one.
    const admin = actor({ roles: ["CUSTOMER", "ADMIN"] });
    expect(can(admin, "expert_workspace:access")).toBe(false);
    expect(can(admin, "admin:review_expert")).toBe(true);
  });
});

describe("requirement 1 — one account, both roles", () => {
  it("recognises a dual-role account", () => {
    expect(isDualRole(withExpert("APPROVED"))).toBe(true);
    expect(isDualRole(actor())).toBe(false);
  });

  it("lets a plain customer start an application", () => {
    expect(can(actor({ roles: ["CUSTOMER"] }), "expert_application:start")).toBe(true);
  });

  it("treats 'already applied' as a state question, not a permission one", () => {
    // The policy permits it; the service returns the application already in
    // flight rather than creating a second one. That keeps a double-click a
    // success instead of a 403, and keeps the service's race guard reachable.
    // Either way the user cannot end up with two applications —
    // expert-lifecycle.test.ts asserts that directly.
    expect(can(withExpert("DRAFT"), "expert_application:start")).toBe(true);
    expect(can(withExpert("APPROVED"), "expert_application:start")).toBe(true);
  });

  it("keeps customer permissions after becoming an expert", () => {
    const dual = withExpert("APPROVED");
    expect(can(dual, "account:read_self")).toBe(true);
    expect(can(dual, "expert_workspace:access")).toBe(true);
  });
});

describe("suspended and anonymous callers", () => {
  it("gives an anonymous caller nothing", () => {
    expect(can(ANONYMOUS, "account:read_self")).toBe(false);
    expect(can(ANONYMOUS, "admin:review_expert")).toBe(false);
    expect(grantedPermissions(ANONYMOUS)).toEqual([]);
  });

  it("strips every permission from a suspended account, including reading itself", () => {
    const suspended = actor({ status: "SUSPENDED", roles: ["CUSTOMER", "EXPERT", "ADMIN"] });
    expect(grantedPermissions(suspended)).toEqual([]);
  });

  it("strips every permission from a deleted account", () => {
    expect(grantedPermissions(actor({ status: "DELETED", roles: ["ADMIN"] }))).toEqual([]);
  });
});

describe("admin permissions", () => {
  it("denies every admin permission to a non-admin", () => {
    const dual = withExpert("APPROVED");
    for (const permission of grantedPermissions(dual)) {
      expect(permission.startsWith("admin:")).toBe(false);
    }
  });

  it("grants them to an admin", () => {
    const admin = actor({ roles: ["ADMIN"] });
    expect(can(admin, "admin:read_experts")).toBe(true);
    expect(can(admin, "admin:suspend_expert")).toBe(true);
  });
});

describe("application editing window", () => {
  it("allows edits while DRAFT", () => {
    expect(can(withExpert("DRAFT"), "expert_application:update_own")).toBe(true);
  });

  it("allows a rejected application to be reworked", () => {
    expect(can(withExpert("REJECTED"), "expert_application:update_own")).toBe(true);
  });

  it("freezes an application that is with an admin", () => {
    expect(can(withExpert("SUBMITTED"), "expert_application:update_own")).toBe(false);
    expect(can(withExpert("UNDER_REVIEW"), "expert_application:update_own")).toBe(false);
  });

  it("only allows submitting from DRAFT", () => {
    expect(can(withExpert("DRAFT"), "expert_application:submit_own")).toBe(true);
    expect(can(withExpert("SUBMITTED"), "expert_application:submit_own")).toBe(false);
    expect(can(withExpert("APPROVED"), "expert_application:submit_own")).toBe(false);
  });
});

describe("authorize()", () => {
  it("throws UnauthenticatedError for anonymous", () => {
    expect(() => authorize(ANONYMOUS, "account:read_self")).toThrow(UnauthenticatedError);
  });

  it("throws ForbiddenError when authenticated but unprivileged", () => {
    expect(() => authorize(actor(), "admin:review_expert")).toThrow(ForbiddenError);
  });

  it("returns silently when permitted", () => {
    expect(() => authorize(actor(), "account:read_self")).not.toThrow();
  });
});
