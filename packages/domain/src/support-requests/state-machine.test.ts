import type { RequestState } from "@sfx/contracts";
import { describe, expect, it } from "vitest";
import { IllegalTransitionError } from "../shared/errors.js";
import {
  assertTransition,
  canTransition,
  isTerminal,
  nextStates,
  TERMINAL_STATES,
  TRANSITIONS,
} from "./state-machine.js";

const ALL_STATES: RequestState[] = [
  "CREATED",
  "CLASSIFYING",
  "SEARCHING",
  "OFFERED",
  "ACCEPTED",
  "PAYMENT_PENDING",
  "READY",
  "IN_SESSION",
  "COMPLETED",
  "CANCELLED",
  "NO_EXPERT_FOUND",
  "DISPUTED",
  "REFUNDED",
];

describe("state machine — structure", () => {
  it("has no duplicate (from, to) pairs", () => {
    const pairs = TRANSITIONS.map((rule) => `${rule.from}→${rule.to}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it("lets nothing escape a terminal state", () => {
    for (const state of TERMINAL_STATES) {
      expect(nextStates(state)).toEqual([]);
      expect(isTerminal(state)).toBe(true);
    }
  });

  it("gives every non-terminal state somewhere to go", () => {
    // A state with no exit is a request stuck forever with no operator recourse.
    for (const state of ALL_STATES) {
      if (isTerminal(state)) continue;
      expect(nextStates(state).length, `${state} is a dead end`).toBeGreaterThan(0);
    }
  });

  it("names only implemented guards", () => {
    const known = new Set([
      "hasEligibleCandidate",
      "offerStillOpen",
      "adminReasonProvided",
      "paymentAuthorizationValid",
      "paymentConfirmed",
      "withinDisputeWindow",
    ]);
    for (const rule of TRANSITIONS) {
      if (rule.guard) expect(known.has(rule.guard), `unknown guard ${rule.guard}`).toBe(true);
    }
  });
});

describe("state machine — the D1 happy path", () => {
  it("runs CREATED → … → COMPLETED without a payment step after acceptance", () => {
    // D1: authorization happens at submission, so an expert who accepts is
    // never left waiting on a customer to enter card details.
    const path: RequestState[] = [
      "CREATED",
      "CLASSIFYING",
      "SEARCHING",
      "OFFERED",
      "ACCEPTED",
      "READY",
      "IN_SESSION",
      "COMPLETED",
    ];
    const hops = path.slice(0, -1).map((from, i) => [from, path[i + 1]] as const);
    for (const [from, to] of hops) {
      if (to === undefined) continue;
      expect(canTransition(from, to), `${from} → ${to}`).toBe(true);
    }
    expect(path).not.toContain("PAYMENT_PENDING");
  });

  it("keeps PAYMENT_PENDING reachable as the documented fallback", () => {
    expect(canTransition("ACCEPTED", "PAYMENT_PENDING")).toBe(true);
    expect(canTransition("PAYMENT_PENDING", "READY")).toBe(true);
    expect(canTransition("PAYMENT_PENDING", "CANCELLED")).toBe(true);
  });
});

describe("state machine — dispatch loop", () => {
  it("cycles OFFERED → SEARCHING → OFFERED on decline or timeout", () => {
    expect(canTransition("OFFERED", "SEARCHING")).toBe(true);
    expect(canTransition("SEARCHING", "OFFERED")).toBe(true);
  });

  it("can give up from either SEARCHING or OFFERED", () => {
    expect(canTransition("SEARCHING", "NO_EXPERT_FOUND")).toBe(true);
    expect(canTransition("OFFERED", "NO_EXPERT_FOUND")).toBe(true);
  });
});

describe("state machine — actor authorization", () => {
  it("lets only an expert accept an offer", () => {
    expect(canTransition("OFFERED", "ACCEPTED", "EXPERT")).toBe(true);
    expect(canTransition("OFFERED", "ACCEPTED", "CUSTOMER")).toBe(false);
    expect(canTransition("OFFERED", "ACCEPTED", "ADMIN")).toBe(false);
    expect(canTransition("OFFERED", "ACCEPTED", "SYSTEM")).toBe(false);
  });

  it("never lets an admin accept on an expert's behalf", () => {
    // C5: both admin dispatch paths create an OFFER. Neither writes ACCEPTED.
    const adminTargets = nextStates("SEARCHING", "ADMIN");
    expect(adminTargets).toContain("OFFERED");
    expect(adminTargets).not.toContain("ACCEPTED");
    expect(nextStates("OFFERED", "ADMIN")).not.toContain("ACCEPTED");
  });

  it("requires a reason when an admin re-assigns over a live offer", () => {
    const rule = TRANSITIONS.find((r) => r.from === "OFFERED" && r.to === "OFFERED");
    expect(rule?.actors).toEqual(["ADMIN"]);
    expect(rule?.guard).toBe("adminReasonProvided");
  });

  it("lets only an admin resolve a dispute", () => {
    expect(canTransition("DISPUTED", "REFUNDED", "ADMIN")).toBe(true);
    expect(canTransition("DISPUTED", "REFUNDED", "CUSTOMER")).toBe(false);
    // Q10: no self-service refund. "Not resolved" is a request for review.
    expect(canTransition("COMPLETED", "REFUNDED", "CUSTOMER")).toBe(false);
  });

  it("allows cancellation only before an expert has committed", () => {
    for (const state of ["CREATED", "CLASSIFYING", "SEARCHING", "OFFERED"] as const) {
      expect(canTransition(state, "CANCELLED", "CUSTOMER")).toBe(true);
    }
    for (const state of ["ACCEPTED", "READY", "IN_SESSION", "COMPLETED"] as const) {
      expect(canTransition(state, "CANCELLED", "CUSTOMER")).toBe(false);
    }
  });
});

describe("assertTransition", () => {
  it("throws on an illegal move and says what was legal", () => {
    try {
      assertTransition("CREATED", "COMPLETED", "SYSTEM");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalTransitionError);
      expect((error as IllegalTransitionError).message).toContain("CLASSIFYING");
    }
  });

  it("throws when the move is legal but the actor is not", () => {
    expect(() => assertTransition("OFFERED", "ACCEPTED", "CUSTOMER")).toThrow(
      IllegalTransitionError,
    );
  });

  it("returns the rule on a permitted move", () => {
    const rule = assertTransition("OFFERED", "ACCEPTED", "EXPERT");
    expect(rule.guard).toBe("offerStillOpen");
  });
});
