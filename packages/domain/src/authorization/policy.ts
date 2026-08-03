import { ForbiddenError, UnauthenticatedError } from "../shared/errors.js";
import { hasRole, isAuthenticated, type Actor, type MaybeActor } from "./actor.js";

/**
 * Server-side authorization (§30, requirement 4).
 *
 * Every permission decision in the product resolves here. UI visibility is a
 * convenience for the user, never a control: a hidden button and a missing
 * permission are unrelated facts, and only the second one is enforcement.
 *
 * Pure and dependency-free, so the whole permission matrix is unit-testable
 * without a database, a session, or an HTTP request.
 */

/**
 * The complete permission set, declared once so `grantedPermissions` cannot
 * drift out of sync with what `can()` actually decides.
 */
export const PERMISSIONS = [
  // Own account
  "account:read_self",
  "account:update_self",
  // Expert application, performed by the applicant
  "expert_application:start",
  "expert_application:read_own",
  "expert_application:update_own",
  "expert_application:submit_own",
  // Expert workspace, gated on an APPROVED application
  "expert_workspace:access",
  // Expert self-service. Available to any applicant — an expert can keep their
  // profile and skills current while under review. Only *availability* is
  // gated on approval (requirement 3), and that gate lives in the service
  // because it depends on the application status rather than on a role.
  "expert_profile:read_own",
  "expert_profile:update_own",
  "expert_skill:read_own",
  "expert_skill:update_own",
  "expert_availability:read_own",
  "expert_availability:update_own",
  // Support requests, from the customer side
  "support_request:create",
  "support_request:read_own",
  "support_request:cancel_own",
  "attachment:upload",
  // Offers, from the expert side
  "offer:read_own",
  "offer:respond",
  // Administration
  "admin:read_experts",
  "admin:read_requests",
  "admin:verify_expert_skill",
  "admin:review_expert",
  "admin:suspend_expert",
  "admin:reinstate_expert",
  "admin:read_users",
  // Manual dispatch (§C5). Two permissions rather than one: overriding *who*
  // gets offered is an everyday operational act, overriding the competence
  // rules themselves is not, and a later role split should be able to separate
  // them without touching call sites.
  "matching:admin_assign",
  "matching:admin_force_assign",
  "matching:read_audit",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Requirement 2, in one place.
 *
 * Holding the EXPERT role means "has started an application". It does NOT mean
 * approved, and it does NOT confer eligibility for anything. Access to the
 * expert workspace requires an APPROVED profile — and even that is not
 * matching eligibility, which adds availability and heartbeat in Phases 4–5.
 */
export function canAccessExpertWorkspace(actor: Actor): boolean {
  return actor.status === "ACTIVE" && actor.expert?.status === "APPROVED";
}

export function can(actor: MaybeActor, permission: Permission): boolean {
  if (!isAuthenticated(actor)) return false;

  // A suspended or deleted account has no permissions at all — not even to read
  // itself. Checked before anything else so no later branch can grant one.
  if (actor.status !== "ACTIVE") return false;

  switch (permission) {
    case "admin:read_experts":
    case "admin:read_requests":
    case "admin:verify_expert_skill":
    case "admin:review_expert":
    case "admin:suspend_expert":
    case "admin:reinstate_expert":
    case "admin:read_users":
    case "matching:admin_assign":
    case "matching:admin_force_assign":
    case "matching:read_audit":
      return hasRole(actor, "ADMIN");

    case "account:read_self":
    case "account:update_self":
      return true;

    // Every account is a customer, so these need no role check beyond ACTIVE.
    // An approved expert requesting help for themselves is a legitimate and
    // expected use of the product, not an edge case to block.
    case "support_request:create":
    case "support_request:read_own":
    case "support_request:cancel_own":
    case "attachment:upload":
      return true;

    case "expert_application:start":
      // Any active user may apply — including an existing customer, who keeps
      // the same account and simply gains the EXPERT role (requirement 1).
      //
      // Deliberately NOT gated on `actor.expert === undefined`. Whether an
      // application already exists is a state question, not a permission one:
      // the service answers it idempotently by returning the application
      // already in flight. Gating here would make a double-click a 403 and
      // would leave the service's idempotency guard — the thing that actually
      // protects against two concurrent starts racing — unreachable.
      return true;

    case "expert_application:read_own":
      return actor.expert !== undefined;

    case "expert_application:update_own":
      // Editable while the applicant still owns it. Once SUBMITTED or
      // UNDER_REVIEW it is the admin's to act on; a REJECTED application can be
      // reworked, which is what makes rejection recoverable rather than final.
      return actor.expert?.status === "DRAFT" || actor.expert?.status === "REJECTED";

    case "expert_application:submit_own":
      return actor.expert?.status === "DRAFT";

    case "expert_workspace:access":
      return canAccessExpertWorkspace(actor);

    // An offer can only exist for an approved expert, but the check that
    // matters is ownership of the *attempt row*, which the service does. This
    // permission stops an unapproved account from reaching the endpoint at all.
    case "offer:read_own":
    case "offer:respond":
      return canAccessExpertWorkspace(actor);

    // Requires an application to exist, but NOT an approved one: a DRAFT
    // applicant lists their skills as part of applying. Requirement 3's gate is
    // on going AVAILABLE, which the availability service checks against the
    // application status — a permission cannot express it, because the policy
    // deliberately knows nothing about what "matchable" means.
    case "expert_profile:read_own":
    case "expert_profile:update_own":
    case "expert_skill:read_own":
    case "expert_skill:update_own":
    case "expert_availability:read_own":
    case "expert_availability:update_own":
      return actor.expert !== undefined;

    default: {
      // Exhaustiveness: a new Permission without a branch fails to compile
      // rather than silently defaulting to allowed.
      const unhandled: never = permission;
      throw new Error(`Unhandled permission: ${String(unhandled)}`);
    }
  }
}

/** Throwing form, for use at the top of every service method. */
export function authorize(actor: MaybeActor, permission: Permission): asserts actor is Actor {
  if (!isAuthenticated(actor)) {
    throw new UnauthenticatedError(`${permission} requires authentication`);
  }
  if (!can(actor, permission)) {
    throw new ForbiddenError(permission, `user:${actor.userId}`);
  }
}

/**
 * Every permission the actor currently holds.
 *
 * Sent to the client so the UI can hide what is unavailable. That is presentation
 * only — the server re-decides on every request, and a client that fabricates
 * this list gains nothing (requirement 4).
 */
export function grantedPermissions(actor: MaybeActor): Permission[] {
  return PERMISSIONS.filter((permission) => can(actor, permission));
}
