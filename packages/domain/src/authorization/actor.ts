import type { ExpertStatus, UserRole } from "@sfx/contracts";

/**
 * Who is making a request, as the domain sees it.
 *
 * Built server-side from the authenticated session — never from anything the
 * client sends. A client that posts `{"roles":["ADMIN"]}` changes nothing,
 * because no code path constructs an Actor from a request body.
 */
export interface Actor {
  readonly userId: string;
  readonly email: string;
  readonly roles: readonly UserRole[];
  readonly status: "ACTIVE" | "SUSPENDED" | "DELETED";
  /**
   * Every account has one — it is bootstrapped on the first authenticated
   * request. Optional in the type only because the session builder constructs
   * the Actor before it can guarantee the row exists.
   */
  readonly customerProfileId?: string;
  /** Present only when the user has started an expert application. */
  readonly expert?: {
    readonly profileId: string;
    readonly status: ExpertStatus;
  };
}

/** An unauthenticated caller. Distinct from "authenticated but unprivileged". */
export const ANONYMOUS = Symbol("anonymous");
export type MaybeActor = Actor | typeof ANONYMOUS;

export function isAuthenticated(actor: MaybeActor): actor is Actor {
  return actor !== ANONYMOUS;
}

export function hasRole(actor: Actor, role: UserRole): boolean {
  return actor.roles.includes(role);
}

/**
 * Requirement 1 — one account, many roles.
 *
 * A customer who later becomes an expert gains the EXPERT role on the *same*
 * user. There is deliberately no second identity, no linked-accounts table, and
 * no "expert account" concept: `roles` is an array precisely so this is a row
 * update rather than a new signup.
 */
export function isDualRole(actor: Actor): boolean {
  return hasRole(actor, "CUSTOMER") && hasRole(actor, "EXPERT");
}
