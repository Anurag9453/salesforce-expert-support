import type { AvailabilityChangeSource, AvailabilityStatus, ExpertStatus } from "@sfx/contracts";
import { IllegalTransitionError } from "../shared/errors.js";
import { isEligibleForMatching } from "./expert-status.js";

/**
 * Expert availability and matching eligibility (§11, requirements 3–6).
 *
 * Two separate ideas that are easy to conflate, kept apart deliberately:
 *
 * - **Availability** is what the expert controls. A toggle.
 * - **Matching eligibility** is what the dispatcher asks. It is a conjunction
 *   of conditions, only one of which is the toggle.
 *
 * Requirement 4 is the reason `evaluateEligibility` returns *reasons* rather
 * than a bare boolean: the expert dashboard has to be able to say precisely why
 * someone is not receiving requests, and Phase 5's matching engine has to log
 * why a candidate was excluded. A boolean answers neither question.
 */

// ── Availability transitions ─────────────────────────────────────────────────

/**
 * Re-exported from contracts, where it has to live so the ports can name it
 * without importing a domain module. Kept visible here because this is the file
 * that gives it meaning.
 */
export type { AvailabilityChangeSource };

export interface AvailabilityTransition {
  readonly from: AvailabilityStatus;
  readonly to: AvailabilityStatus;
  readonly sources: readonly AvailabilityChangeSource[];
  readonly description: string;
}

/**
 * `ON_OFFER` and `IN_SESSION` are reached only by the system, never by the
 * expert — an expert cannot put themselves on offer, and cannot escape one by
 * toggling off. Phases 5 and 6 own those edges; they are declared here so the
 * machine is complete rather than growing edges ad hoc later.
 */
export const AVAILABILITY_TRANSITIONS: readonly AvailabilityTransition[] = [
  {
    from: "OFFLINE",
    to: "AVAILABLE",
    sources: ["MANUAL_TOGGLE", "ADMIN"],
    description: "Expert went available. The only route into AVAILABLE.",
  },
  {
    from: "AVAILABLE",
    to: "OFFLINE",
    sources: ["MANUAL_TOGGLE", "HEARTBEAT_TIMEOUT", "ADMIN"],
    description: "Expert went offline, or their presence went stale.",
  },
  {
    from: "AVAILABLE",
    to: "ON_OFFER",
    sources: ["OFFER_LOCK"],
    description: "Dispatcher offered a request. Phase 5.",
  },
  {
    from: "OFFLINE",
    to: "ON_OFFER",
    sources: ["ADMIN"],
    description:
      "Admin force-assigned to an offline expert they had already reached out-of-band (§C5). " +
      "ADMIN only — the dispatcher can never reach an offline expert, and the offer still " +
      "has to be accepted.",
  },
  {
    from: "ON_OFFER",
    to: "AVAILABLE",
    sources: ["OFFER_RELEASED"],
    description: "Offer declined or timed out. Phase 5.",
  },
  {
    from: "ON_OFFER",
    to: "IN_SESSION",
    sources: ["SESSION_START"],
    description: "Offer accepted. Phase 8.",
  },
  {
    from: "ON_OFFER",
    to: "OFFLINE",
    sources: ["HEARTBEAT_TIMEOUT", "ADMIN"],
    description: "Presence went stale while an offer was open.",
  },
  {
    from: "IN_SESSION",
    to: "AVAILABLE",
    sources: ["SESSION_END"],
    description: "Session finished; expert stays on. Phase 8.",
  },
  {
    from: "IN_SESSION",
    to: "OFFLINE",
    sources: ["SESSION_END", "ADMIN"],
    description: "Session finished and the expert chose to stop.",
  },
];

const INDEX = new Map(AVAILABILITY_TRANSITIONS.map((rule) => [`${rule.from}→${rule.to}`, rule]));

export function findAvailabilityTransition(
  from: AvailabilityStatus,
  to: AvailabilityStatus,
): AvailabilityTransition | undefined {
  return INDEX.get(`${from}→${to}`);
}

export function canChangeAvailability(
  from: AvailabilityStatus,
  to: AvailabilityStatus,
  source: AvailabilityChangeSource,
): boolean {
  const rule = findAvailabilityTransition(from, to);
  return rule !== undefined && rule.sources.includes(source);
}

export function assertAvailabilityTransition(
  from: AvailabilityStatus,
  to: AvailabilityStatus,
  source: AvailabilityChangeSource,
): AvailabilityTransition {
  const rule = findAvailabilityTransition(from, to);
  if (!rule) {
    throw new IllegalTransitionError<AvailabilityStatus>(from, to, "no such availability edge");
  }
  if (!rule.sources.includes(source)) {
    throw new IllegalTransitionError<AvailabilityStatus>(
      from,
      to,
      `${source} may not perform this change (allowed: ${rule.sources.join(", ")})`,
    );
  }
  return rule;
}

// ── Requirement 3: only an APPROVED expert may go AVAILABLE ──────────────────

/**
 * The gate on the availability API.
 *
 * Deliberately a separate, tiny function so it can be asserted directly against
 * every `ExpertStatus`. An expert in DRAFT, SUBMITTED, UNDER_REVIEW, REJECTED or
 * SUSPENDED cannot become matching-eligible through this route, however the UI
 * behaves — including a SUSPENDED expert who was AVAILABLE a moment ago.
 */
export function canGoAvailable(expertStatus: ExpertStatus): boolean {
  return isEligibleForMatching(expertStatus);
}

// ── Presence ─────────────────────────────────────────────────────────────────

export const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 45;
/**
 * Three minutes, not one.
 *
 * Browsers throttle `setInterval` in a background tab to roughly once a minute,
 * so a tighter window would sweep people who are merely on another tab. The
 * cost of being generous is a stale expert absorbing at most one offer; the cost
 * of being tight is sweeping experts who are present and willing.
 */
export const DEFAULT_HEARTBEAT_STALE_AFTER_SECONDS = 180;

export function isHeartbeatFresh(
  lastHeartbeatAt: Date | null | undefined,
  now: Date,
  staleAfterSeconds: number = DEFAULT_HEARTBEAT_STALE_AFTER_SECONDS,
): boolean {
  if (!lastHeartbeatAt) return false;
  return now.getTime() - lastHeartbeatAt.getTime() <= staleAfterSeconds * 1000;
}

export function secondsSinceHeartbeat(
  lastHeartbeatAt: Date | null | undefined,
  now: Date,
): number | null {
  if (!lastHeartbeatAt) return null;
  return Math.max(0, Math.floor((now.getTime() - lastHeartbeatAt.getTime()) / 1000));
}

// ── Requirement 4: the composed eligibility predicate ────────────────────────

/**
 * Why an expert is not currently receiving requests.
 *
 * Ordered by how the expert should act on them: the things they can fix
 * themselves come first.
 */
export type IneligibilityReason =
  | "NOT_APPROVED"
  | "ACCOUNT_NOT_ACTIVE"
  | "NOT_AVAILABLE"
  | "PRESENCE_STALE"
  | "ALREADY_ON_OFFER"
  | "IN_SESSION"
  | "NO_MATCHING_SKILLS";

export const REASON_COPY: Record<IneligibilityReason, string> = {
  NOT_APPROVED: "Your application has not been approved yet.",
  ACCOUNT_NOT_ACTIVE: "Your account is not active.",
  NOT_AVAILABLE: "You are set to offline.",
  PRESENCE_STALE: "We have not heard from your browser recently.",
  ALREADY_ON_OFFER: "You already have a request waiting on your answer.",
  IN_SESSION: "You are in a session.",
  NO_MATCHING_SKILLS: "This request needs skills you have not listed.",
};

export interface EligibilityInput {
  readonly expertStatus: ExpertStatus;
  readonly accountStatus: "ACTIVE" | "SUSPENDED" | "DELETED";
  readonly availabilityStatus: AvailabilityStatus;
  readonly lastHeartbeatAt: Date | null;
  readonly now: Date;
  readonly heartbeatStaleAfterSeconds?: number;
}

export interface EligibilityResult {
  readonly eligible: boolean;
  readonly reasons: readonly IneligibilityReason[];
}

/**
 * Requirement 4 in one place.
 *
 * Being APPROVED is necessary and **not** sufficient. Every condition is
 * evaluated — not short-circuited — so the dashboard can list everything that
 * is wrong at once rather than making the expert fix one thing, refresh, and
 * discover the next.
 *
 * Phase 5 adds skill competence per request; `NO_MATCHING_SKILLS` is declared
 * here so the reason vocabulary is complete and the matching engine's audit
 * rows can use the same words the expert sees.
 */
export function evaluateEligibility(input: EligibilityInput): EligibilityResult {
  const reasons: IneligibilityReason[] = [];

  if (input.accountStatus !== "ACTIVE") reasons.push("ACCOUNT_NOT_ACTIVE");
  if (!isEligibleForMatching(input.expertStatus)) reasons.push("NOT_APPROVED");

  switch (input.availabilityStatus) {
    case "OFFLINE":
      reasons.push("NOT_AVAILABLE");
      break;
    case "ON_OFFER":
      reasons.push("ALREADY_ON_OFFER");
      break;
    case "IN_SESSION":
      reasons.push("IN_SESSION");
      break;
    case "AVAILABLE":
      break;
    default: {
      const never: never = input.availabilityStatus;
      throw new Error(`Unhandled availability status: ${String(never)}`);
    }
  }

  // Presence only matters for someone claiming to be available. Reporting a
  // stale heartbeat to an expert who is deliberately offline is noise.
  if (
    input.availabilityStatus === "AVAILABLE" &&
    !isHeartbeatFresh(input.lastHeartbeatAt, input.now, input.heartbeatStaleAfterSeconds)
  ) {
    reasons.push("PRESENCE_STALE");
  }

  return { eligible: reasons.length === 0, reasons };
}

/** True only when every condition holds. The dispatcher's question. */
export function isCurrentlyMatchable(input: EligibilityInput): boolean {
  return evaluateEligibility(input).eligible;
}
