import type { SessionView } from "@sfx/contracts";
import {
  ANONYMOUS,
  grantedPermissions,
  isEligibleForMatching,
  UnauthenticatedError,
  type Actor,
  type MaybeActor,
} from "@sfx/domain";
import { headers } from "next/headers";
import { getAuth } from "./auth.js";
import { getContainer } from "./container.js";

/**
 * Builds the domain Actor from the authenticated session.
 *
 * This is the *only* place an Actor is constructed, and every field comes from
 * the database — never from a request body, header, or cookie payload beyond
 * the session token itself. A client that posts `{"roles":["ADMIN"]}` changes
 * nothing, because no code path reads roles from input (requirement 4).
 */
export async function getActor(): Promise<MaybeActor> {
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) return ANONYMOUS;

  const { prisma, accounts } = getContainer();

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      email: true,
      roles: true,
      status: true,
      expert: { select: { id: true, status: true } },
    },
  });
  if (!user) return ANONYMOUS;

  // Requirement 1: CUSTOMER is the baseline for every account. Bootstrapping
  // here rather than in an auth-provider hook covers every sign-in path —
  // email/password, Google, and anything added later — with one idempotent
  // call. The user row was already fetched, so this costs one extra query only
  // on the first authenticated request of a new account.
  await accounts.ensureCustomerProfile(user.id);

  return {
    userId: user.id,
    email: user.email,
    roles: user.roles,
    status: user.status,
    ...(user.expert ? { expert: { profileId: user.expert.id, status: user.expert.status } } : {}),
  };
}

/** Throws rather than returning ANONYMOUS. For routes that require a session. */
export async function requireActor(): Promise<Actor> {
  const actor = await getActor();
  if (actor === ANONYMOUS) throw new UnauthenticatedError();
  return actor;
}

/**
 * What the client is told about itself.
 *
 * `permissions` exists so the UI can hide unavailable actions. It is
 * presentation only: the server re-decides on every request, so a client that
 * edits this list gains nothing but a button that 403s.
 */
export function toSessionView(actor: Actor): SessionView {
  return {
    userId: actor.userId,
    email: actor.email,
    name: actor.email,
    roles: [...actor.roles],
    status: actor.status,
    expert: actor.expert
      ? {
          profileId: actor.expert.profileId,
          status: actor.expert.status,
          // Requirement 2: computed on the server from the application status.
          // The client is never trusted to derive this, and never shown a value
          // it could have inferred from a role.
          eligibleForMatching: isEligibleForMatching(actor.expert.status),
        }
      : null,
    permissions: grantedPermissions(actor),
  };
}
