import type { RequestState } from "@sfx/contracts";
import { IllegalTransitionError } from "../shared/errors.js";

/**
 * The support-request state machine (§16, ARCHITECTURE.md §4).
 *
 * The table below is the single definition of what may happen to a request.
 * `transition()` in the service layer is the only code permitted to write
 * `SupportRequest.state`, and it consults this table first. There are no
 * boolean status flags anywhere in the schema — §16 taken literally.
 *
 * Pure and dependency-free, so every legality rule is unit-testable without a
 * database (§35).
 */

export type TransitionActor = "SYSTEM" | "CUSTOMER" | "EXPERT" | "ADMIN";

export interface TransitionRule {
  readonly from: RequestState;
  readonly to: RequestState;
  /** Who may trigger this move. An admin-only move is not reachable by a customer. */
  readonly actors: readonly TransitionActor[];
  /** Named precondition the service layer must evaluate before committing. */
  readonly guard?: string;
  readonly description: string;
}

/**
 * Two paths reach ACCEPTED, and they exist side by side on purpose.
 *
 * **Direct dispatch** (SEARCHING → OFFERED → ACCEPTED) is the original loop: the
 * platform picks, one expert holds an exclusive 60-second offer, payment was
 * authorized at submission (D1) so ACCEPTED goes straight to READY.
 *
 * **Shortlist** (SEARCHING → SHORTLISTED → AWAITING_EXPERT_CONFIRMATION →
 * ACCEPTED → PAYMENT_PENDING) is the customer-choice flow: experts raise a hand,
 * the best three are shown, the customer picks one, and that expert has two
 * minutes to confirm. Nothing is charged until both sides have said yes, which
 * is why PAYMENT_PENDING — retained but unreachable under D1 — becomes the main
 * path here rather than a fallback.
 *
 * The failure edges matter more than the happy ones. A customer who picks
 * someone who then does not confirm must land back on the shortlist with that
 * person removed, never stranded: hence AWAITING_EXPERT_CONFIRMATION →
 * SHORTLISTED, and SHORTLISTED → SEARCHING when the list empties out.
 */
export const TRANSITIONS: readonly TransitionRule[] = [
  {
    from: "CREATED",
    to: "CLASSIFYING",
    actors: ["SYSTEM"],
    description: "Worker picked up the classification job.",
  },
  {
    from: "CLASSIFYING",
    to: "SEARCHING",
    actors: ["SYSTEM"],
    description:
      "Classified, or the classifier failed and we fell back to customer-selected skills (§8).",
  },
  {
    from: "SEARCHING",
    to: "OFFERED",
    actors: ["SYSTEM", "ADMIN"],
    guard: "hasEligibleCandidate",
    description: "Ranked candidate offered, or an admin assigned one (§C5).",
  },
  {
    from: "SEARCHING",
    to: "SHORTLISTED",
    actors: ["SYSTEM"],
    guard: "hasInterestedCandidates",
    description: "Interest window closed with at least one candidate; the best three are shown.",
  },
  {
    from: "SHORTLISTED",
    to: "AWAITING_EXPERT_CONFIRMATION",
    actors: ["CUSTOMER"],
    guard: "candidateIsShortlisted",
    description: "Customer chose one of the three; that expert has two minutes to confirm.",
  },
  {
    from: "AWAITING_EXPERT_CONFIRMATION",
    to: "ACCEPTED",
    actors: ["EXPERT"],
    description: "The chosen expert confirmed. Both sides have now agreed.",
  },
  {
    from: "AWAITING_EXPERT_CONFIRMATION",
    to: "SHORTLISTED",
    actors: ["SYSTEM"],
    description:
      "The chosen expert let the two minutes lapse. They are dropped and the customer picks again from those left.",
  },
  {
    from: "SHORTLISTED",
    to: "SEARCHING",
    actors: ["SYSTEM"],
    description: "The shortlist emptied out — everyone lapsed or withdrew. Search again.",
  },
  {
    from: "SHORTLISTED",
    to: "NO_EXPERT_FOUND",
    actors: ["SYSTEM"],
    description: "The 15-minute deadline passed while the customer was deciding.",
  },
  {
    from: "SEARCHING",
    to: "NO_EXPERT_FOUND",
    actors: ["SYSTEM"],
    description: "Pool exhausted at maximum relaxation, or the 15-minute deadline passed.",
  },
  {
    from: "OFFERED",
    to: "ACCEPTED",
    actors: ["EXPERT"],
    guard: "offerStillOpen",
    description: "Expert accepted. Idempotent — a late second accept is a no-op.",
  },
  {
    from: "OFFERED",
    to: "SEARCHING",
    actors: ["SYSTEM", "EXPERT"],
    description: "Declined or timed out; candidates remain and the deadline has not passed.",
  },
  {
    from: "OFFERED",
    to: "NO_EXPERT_FOUND",
    actors: ["SYSTEM"],
    description: "Declined or timed out with no candidates left.",
  },
  {
    from: "OFFERED",
    to: "OFFERED",
    actors: ["ADMIN"],
    guard: "adminReasonProvided",
    description:
      "Admin re-assigned over a live offer. Supersedes the open attempt; the new expert must still accept (§C5).",
  },
  {
    from: "ACCEPTED",
    to: "READY",
    actors: ["SYSTEM"],
    guard: "paymentAuthorizationValid",
    description: "Session and video room created. The D1 happy path.",
  },
  {
    from: "ACCEPTED",
    to: "PAYMENT_PENDING",
    actors: ["SYSTEM"],
    description:
      "Shortlist flow: both sides have agreed, so now the customer pays. Was a fallback under D1 (authorize-before-matching); it is the main path whenever the customer chose from a shortlist.",
  },
  {
    from: "PAYMENT_PENDING",
    to: "READY",
    actors: ["SYSTEM"],
    guard: "paymentConfirmed",
    description: "Verified webhook confirmed payment.",
  },
  {
    from: "PAYMENT_PENDING",
    to: "CANCELLED",
    actors: ["SYSTEM"],
    description: "Payment failed or was abandoned.",
  },
  {
    from: "READY",
    to: "IN_SESSION",
    actors: ["SYSTEM"],
    description: "First participant joined the room.",
  },
  {
    from: "IN_SESSION",
    to: "COMPLETED",
    actors: ["SYSTEM", "CUSTOMER", "EXPERT"],
    description: "Either party ended the session, or the duration plus grace elapsed.",
  },
  {
    from: "COMPLETED",
    to: "DISPUTED",
    actors: ["CUSTOMER"],
    guard: "withinDisputeWindow",
    description: "Customer raised a dispute within 7 days.",
  },
  {
    from: "DISPUTED",
    to: "COMPLETED",
    actors: ["ADMIN"],
    description: "Admin resolved the dispute without a refund (§Q10 — manual review).",
  },
  {
    from: "DISPUTED",
    to: "REFUNDED",
    actors: ["ADMIN"],
    description: "Admin resolved the dispute with a refund.",
  },
  // Customer cancellation, permitted only before an expert has committed.
  ...(["CREATED", "CLASSIFYING", "SEARCHING", "OFFERED"] as const).map((from): TransitionRule => ({
    from,
    to: "CANCELLED",
    actors: ["CUSTOMER", "ADMIN"],
    description: "Customer cancelled before acceptance; the authorization is voided.",
  })),
];

/** No transition leaves these. COMPLETED is soft-terminal until the dispute window closes. */
export const TERMINAL_STATES: readonly RequestState[] = [
  "NO_EXPERT_FOUND",
  "CANCELLED",
  "REFUNDED",
];

const INDEX: ReadonlyMap<string, TransitionRule> = new Map(
  TRANSITIONS.map((rule) => [`${rule.from}→${rule.to}`, rule]),
);

export function isTerminal(state: RequestState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function findTransition(from: RequestState, to: RequestState): TransitionRule | undefined {
  return INDEX.get(`${from}→${to}`);
}

export function canTransition(
  from: RequestState,
  to: RequestState,
  actor?: TransitionActor,
): boolean {
  const rule = findTransition(from, to);
  if (!rule) return false;
  return actor === undefined || rule.actors.includes(actor);
}

/**
 * Throws unless the move is legal for this actor. Called by `transition()`
 * inside the row lock, before any write.
 */
export function assertTransition(
  from: RequestState,
  to: RequestState,
  actor: TransitionActor,
): TransitionRule {
  const rule = findTransition(from, to);
  if (!rule) {
    const legal = nextStates(from);
    throw new IllegalTransitionError(
      from,
      to,
      legal.length > 0 ? `legal targets are ${legal.join(", ")}` : "state is terminal",
    );
  }
  if (!rule.actors.includes(actor)) {
    throw new IllegalTransitionError(
      from,
      to,
      `actor ${actor} may not perform this transition (allowed: ${rule.actors.join(", ")})`,
    );
  }
  return rule;
}

export function nextStates(from: RequestState, actor?: TransitionActor): RequestState[] {
  return TRANSITIONS.filter(
    (rule) => rule.from === from && (actor === undefined || rule.actors.includes(actor)),
  ).map((rule) => rule.to);
}

/** Guard names referenced by the table, for the service layer to implement. */
export const GUARDS = [
  "hasEligibleCandidate",
  "offerStillOpen",
  "adminReasonProvided",
  "paymentAuthorizationValid",
  "paymentConfirmed",
  "withinDisputeWindow",
] as const;

export type GuardName = (typeof GUARDS)[number];
