import type { SessionState } from "@sfx/contracts";

/**
 * When a session may start, when it is over, and how long it actually ran.
 *
 * Pure, and separate from `SessionService` for the same reason `shortlist.ts` is
 * separate from the dispatch loop: these are the rules people will argue about
 * — "the expert says they were there", "the customer says it never started",
 * "we were cut off at 58 minutes" — and an argument is much easier to settle
 * against a function than against a service that also talks to a video provider
 * and a database.
 *
 * ```
 *   SCHEDULED ──room created──▶ READY ──first join──▶ ACTIVE ──▶ COMPLETED
 *       │                         │                     │
 *       └───────────────── nobody showed up ────────────┴──▶ ABANDONED
 * ```
 */

/** Minutes past the purchased duration before a session is auto-closed. */
export const OVERRUN_GRACE_MINUTES = 10;

/**
 * How long a room stays open before the session is written off.
 *
 * Generous on purpose. A customer who joins nine minutes late has still bought
 * an hour, and closing the room at five minutes would hand the platform a fee
 * for a session it prevented from happening.
 */
export const NO_SHOW_AFTER_MINUTES = 15;

const LEGAL: Record<SessionState, readonly SessionState[]> = {
  SCHEDULED: ["READY", "ABANDONED"],
  READY: ["ACTIVE", "ABANDONED"],
  ACTIVE: ["COMPLETED", "ABANDONED"],
  COMPLETED: [],
  ABANDONED: [],
};

export function canSessionTransition(from: SessionState, to: SessionState): boolean {
  return LEGAL[from].includes(to);
}

export function isSessionOver(state: SessionState): boolean {
  return LEGAL[state].length === 0;
}

/**
 * Billable minutes, measured from the wall clock rather than from the purchase.
 *
 * Rounded **up** to the minute, and never above what was bought unless the
 * session was explicitly extended. Rounding up is a deliberate choice in the
 * expert's favour: they were present for part of that minute, and the
 * alternative — flooring — quietly shaves time off every session that does not
 * end on a boundary.
 */
export function minutesDelivered(params: {
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly purchasedMinutes: number;
  readonly extraMinutes?: number;
}): number {
  const elapsedMs = params.endedAt.getTime() - params.startedAt.getTime();
  if (elapsedMs <= 0) return 0;
  const cap = params.purchasedMinutes + (params.extraMinutes ?? 0);
  return Math.min(cap, Math.ceil(elapsedMs / 60_000));
}

/** Seconds left before the purchased time runs out. Never negative. */
export function secondsRemaining(params: {
  readonly startedAt: Date;
  readonly now: Date;
  readonly purchasedMinutes: number;
  readonly extraMinutes?: number;
}): number {
  const total = (params.purchasedMinutes + (params.extraMinutes ?? 0)) * 60_000;
  const elapsed = params.now.getTime() - params.startedAt.getTime();
  return Math.max(0, Math.ceil((total - elapsed) / 1000));
}

/**
 * Should the platform close this session on its own?
 *
 * Two distinct reasons, and they are not the same event. A session nobody
 * joined is a **no-show** — nothing was delivered and nothing should be charged.
 * A session that ran past its time is an **overrun** — everything was delivered
 * and the clock simply stopped mattering. Collapsing them into one "expired"
 * would make the money wrong in one direction or the other.
 */
export function autoCloseReason(params: {
  readonly state: SessionState;
  readonly readyAt: Date | null;
  readonly startedAt: Date | null;
  readonly now: Date;
  readonly purchasedMinutes: number;
  readonly extraMinutes?: number;
}): "NO_SHOW" | "OVERRAN" | null {
  if (params.state === "READY" && params.readyAt) {
    const waited = (params.now.getTime() - params.readyAt.getTime()) / 60_000;
    return waited >= NO_SHOW_AFTER_MINUTES ? "NO_SHOW" : null;
  }

  if (params.state === "ACTIVE" && params.startedAt) {
    const allowed = params.purchasedMinutes + (params.extraMinutes ?? 0) + OVERRUN_GRACE_MINUTES;
    const ran = (params.now.getTime() - params.startedAt.getTime()) / 60_000;
    return ran >= allowed ? "OVERRAN" : null;
  }

  return null;
}

/**
 * Is this actor one of the two people in the session?
 *
 * The whole authorization story for a session, expressed once. There is no
 * "session participant" role and there should not be: participation is a fact
 * about a row, and deriving it anywhere else would let the two answers drift.
 */
export function participantRole(params: {
  readonly customerUserId: string;
  readonly expertUserId: string;
  readonly actorUserId: string;
}): "CUSTOMER" | "EXPERT" | null {
  if (params.actorUserId === params.customerUserId) return "CUSTOMER";
  if (params.actorUserId === params.expertUserId) return "EXPERT";
  return null;
}
