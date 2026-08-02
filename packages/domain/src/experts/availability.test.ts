import type { AvailabilityStatus, ExpertStatus } from "@sfx/contracts";
import { describe, expect, it } from "vitest";
import { IllegalTransitionError } from "../shared/errors.js";
import {
  assertAvailabilityTransition,
  AVAILABILITY_TRANSITIONS,
  canChangeAvailability,
  canGoAvailable,
  DEFAULT_HEARTBEAT_STALE_AFTER_SECONDS,
  evaluateEligibility,
  isCurrentlyMatchable,
  isHeartbeatFresh,
  REASON_COPY,
  secondsSinceHeartbeat,
  type EligibilityInput,
} from "./availability.js";

const ALL_EXPERT_STATUSES: ExpertStatus[] = [
  "DRAFT",
  "SUBMITTED",
  "UNDER_REVIEW",
  "APPROVED",
  "REJECTED",
  "SUSPENDED",
];

const NOW = new Date("2026-08-02T12:00:00Z");

function eligibility(overrides: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    expertStatus: "APPROVED",
    accountStatus: "ACTIVE",
    availabilityStatus: "AVAILABLE",
    lastHeartbeatAt: new Date(NOW.getTime() - 10_000),
    now: NOW,
    ...overrides,
  };
}

describe("requirement 3 — only an APPROVED expert may go AVAILABLE", () => {
  for (const status of ALL_EXPERT_STATUSES) {
    it(`${status} → ${status === "APPROVED" ? "allowed" : "blocked"}`, () => {
      expect(canGoAvailable(status)).toBe(status === "APPROVED");
    });
  }

  it("blocks a suspended expert who was previously approved", () => {
    // The dangerous case: they were legitimately available yesterday.
    expect(canGoAvailable("SUSPENDED")).toBe(false);
  });
});

describe("requirement 4 — APPROVED alone is not eligibility", () => {
  it("an approved, offline expert is not matchable", () => {
    const result = evaluateEligibility(eligibility({ availabilityStatus: "OFFLINE" }));
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("NOT_AVAILABLE");
  });

  it("an approved, available expert with a stale heartbeat is not matchable", () => {
    const result = evaluateEligibility(
      eligibility({ lastHeartbeatAt: new Date(NOW.getTime() - 10 * 60_000) }),
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("PRESENCE_STALE");
  });

  it("an approved, available expert who has never sent a heartbeat is not matchable", () => {
    const result = evaluateEligibility(eligibility({ lastHeartbeatAt: null }));
    expect(result.reasons).toContain("PRESENCE_STALE");
  });

  it("an available but unapproved expert is not matchable", () => {
    // Belt to the braces on requirement 3: even if a bad write set AVAILABLE on
    // an unapproved expert, the dispatcher still refuses them.
    for (const status of ALL_EXPERT_STATUSES.filter((s) => s !== "APPROVED")) {
      const result = evaluateEligibility(eligibility({ expertStatus: status }));
      expect(result.eligible, status).toBe(false);
      expect(result.reasons, status).toContain("NOT_APPROVED");
    }
  });

  it("a suspended account is not matchable however everything else looks", () => {
    const result = evaluateEligibility(eligibility({ accountStatus: "SUSPENDED" }));
    expect(result.reasons).toContain("ACCOUNT_NOT_ACTIVE");
  });

  it("is eligible only when every condition holds at once", () => {
    expect(isCurrentlyMatchable(eligibility())).toBe(true);
  });

  it("reports every problem at once rather than one at a time", () => {
    // So the dashboard can list everything wrong instead of making the expert
    // fix, refresh, discover the next thing, repeat.
    const result = evaluateEligibility(
      eligibility({
        expertStatus: "SUSPENDED",
        accountStatus: "SUSPENDED",
        availabilityStatus: "OFFLINE",
      }),
    );
    expect(result.reasons).toEqual(
      expect.arrayContaining(["ACCOUNT_NOT_ACTIVE", "NOT_APPROVED", "NOT_AVAILABLE"]),
    );
  });

  it("does not nag about presence when the expert is deliberately offline", () => {
    const result = evaluateEligibility(
      eligibility({ availabilityStatus: "OFFLINE", lastHeartbeatAt: null }),
    );
    expect(result.reasons).toContain("NOT_AVAILABLE");
    expect(result.reasons).not.toContain("PRESENCE_STALE");
  });

  it("treats ON_OFFER and IN_SESSION as busy, not as failures", () => {
    expect(evaluateEligibility(eligibility({ availabilityStatus: "ON_OFFER" })).reasons).toContain(
      "ALREADY_ON_OFFER",
    );
    expect(
      evaluateEligibility(eligibility({ availabilityStatus: "IN_SESSION" })).reasons,
    ).toContain("IN_SESSION");
  });

  it("has plain-language copy for every reason it can return", () => {
    // Requirement 6: the expert has to understand why, not read an enum.
    for (const reason of Object.keys(REASON_COPY)) {
      expect(REASON_COPY[reason as keyof typeof REASON_COPY].length).toBeGreaterThan(10);
    }
  });
});

describe("heartbeat freshness", () => {
  it("is fresh inside the window and stale outside it", () => {
    const window = DEFAULT_HEARTBEAT_STALE_AFTER_SECONDS;
    expect(isHeartbeatFresh(new Date(NOW.getTime() - (window - 1) * 1000), NOW)).toBe(true);
    expect(isHeartbeatFresh(new Date(NOW.getTime() - (window + 1) * 1000), NOW)).toBe(false);
  });

  it("treats exactly-at-the-boundary as fresh", () => {
    const at = new Date(NOW.getTime() - DEFAULT_HEARTBEAT_STALE_AFTER_SECONDS * 1000);
    expect(isHeartbeatFresh(at, NOW)).toBe(true);
  });

  it("treats a missing heartbeat as stale", () => {
    expect(isHeartbeatFresh(null, NOW)).toBe(false);
    expect(isHeartbeatFresh(undefined, NOW)).toBe(false);
  });

  it("tolerates browser timer throttling in a background tab", () => {
    // Browsers throttle setInterval to ~1/min when backgrounded. A 90-second
    // gap must not sweep someone who is simply on another tab.
    expect(isHeartbeatFresh(new Date(NOW.getTime() - 90_000), NOW)).toBe(true);
  });

  it("reports seconds since the last heartbeat", () => {
    expect(secondsSinceHeartbeat(new Date(NOW.getTime() - 42_000), NOW)).toBe(42);
    expect(secondsSinceHeartbeat(null, NOW)).toBeNull();
  });
});

describe("availability transitions", () => {
  it("has no duplicate edges", () => {
    const pairs = AVAILABILITY_TRANSITIONS.map((rule) => `${rule.from}→${rule.to}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it("makes OFFLINE → AVAILABLE the only route into AVAILABLE by hand", () => {
    const manual = AVAILABILITY_TRANSITIONS.filter((rule) =>
      rule.sources.includes("MANUAL_TOGGLE"),
    );
    expect(manual.map((r) => `${r.from}→${r.to}`).sort()).toEqual([
      "AVAILABLE→OFFLINE",
      "OFFLINE→AVAILABLE",
    ]);
  });

  it("never lets a manual toggle escape an open offer or a live session", () => {
    // Otherwise an expert could dodge an offer they had already been sent.
    expect(canChangeAvailability("ON_OFFER", "OFFLINE", "MANUAL_TOGGLE")).toBe(false);
    expect(canChangeAvailability("IN_SESSION", "OFFLINE", "MANUAL_TOGGLE")).toBe(false);
  });

  it("never lets an expert put themselves ON_OFFER", () => {
    expect(canChangeAvailability("AVAILABLE", "ON_OFFER", "MANUAL_TOGGLE")).toBe(false);
    expect(canChangeAvailability("AVAILABLE", "ON_OFFER", "OFFER_LOCK")).toBe(true);
  });

  it("lets the sweep take an expert offline from AVAILABLE or ON_OFFER", () => {
    expect(canChangeAvailability("AVAILABLE", "OFFLINE", "HEARTBEAT_TIMEOUT")).toBe(true);
    expect(canChangeAvailability("ON_OFFER", "OFFLINE", "HEARTBEAT_TIMEOUT")).toBe(true);
  });

  it("requirement 5 — the sweep has no edge back into AVAILABLE", () => {
    // There is deliberately no HEARTBEAT_* source that restores availability.
    // Only MANUAL_TOGGLE and ADMIN can, which is what makes the sweep sticky.
    const intoAvailable = AVAILABILITY_TRANSITIONS.filter((rule) => rule.to === "AVAILABLE");
    for (const rule of intoAvailable) {
      expect(rule.sources, `${rule.from}→AVAILABLE`).not.toContain("HEARTBEAT_TIMEOUT");
    }
  });

  it("throws on an unknown edge", () => {
    expect(() =>
      assertAvailabilityTransition("OFFLINE" as AvailabilityStatus, "IN_SESSION", "MANUAL_TOGGLE"),
    ).toThrow(IllegalTransitionError);
  });

  it("throws when the source is not permitted for a real edge", () => {
    expect(() => assertAvailabilityTransition("AVAILABLE", "ON_OFFER", "MANUAL_TOGGLE")).toThrow(
      IllegalTransitionError,
    );
  });
});
