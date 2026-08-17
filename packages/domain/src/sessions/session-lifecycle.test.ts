import { describe, expect, it } from "vitest";
import {
  autoCloseReason,
  canSessionTransition,
  isSessionOver,
  minutesDelivered,
  NO_SHOW_AFTER_MINUTES,
  OVERRUN_GRACE_MINUTES,
  participantRole,
  secondsRemaining,
} from "./session-lifecycle.js";

const AT = (minute: number) => new Date(Date.UTC(2026, 7, 16, 10, minute));

describe("the session's legal moves", () => {
  it("cannot start a session that was never made ready", () => {
    expect(canSessionTransition("SCHEDULED", "ACTIVE")).toBe(false);
    expect(canSessionTransition("SCHEDULED", "READY")).toBe(true);
    expect(canSessionTransition("READY", "ACTIVE")).toBe(true);
  });

  it("cannot reopen a session that has ended", () => {
    for (const state of ["COMPLETED", "ABANDONED"] as const) {
      expect(isSessionOver(state)).toBe(true);
      expect(canSessionTransition(state, "ACTIVE")).toBe(false);
    }
  });

  it("can be abandoned from any state before it ends", () => {
    for (const state of ["SCHEDULED", "READY", "ACTIVE"] as const) {
      expect(canSessionTransition(state, "ABANDONED")).toBe(true);
    }
  });
});

describe("minutes delivered", () => {
  const purchasedMinutes = 60;

  it("rounds up, because the expert was present for part of that minute", () => {
    expect(
      minutesDelivered({
        startedAt: AT(0),
        endedAt: new Date(AT(30).getTime() + 1_000),
        purchasedMinutes,
      }),
    ).toBe(31);
  });

  it("never bills more than was bought", () => {
    // A call that ran 20 minutes over is still a 60-minute session. The overrun
    // is the platform's problem to police, never a surprise on the invoice.
    expect(minutesDelivered({ startedAt: AT(0), endedAt: AT(80), purchasedMinutes })).toBe(60);
  });

  it("bills up to the extended cap once time was explicitly added", () => {
    expect(
      minutesDelivered({ startedAt: AT(0), endedAt: AT(80), purchasedMinutes, extraMinutes: 30 }),
    ).toBe(80);
  });

  it("is zero when the session ended before it began", () => {
    // Clock skew between two writes, not a real negative session.
    expect(minutesDelivered({ startedAt: AT(10), endedAt: AT(9), purchasedMinutes })).toBe(0);
  });
});

describe("time remaining", () => {
  it("counts down from the purchased duration", () => {
    expect(secondsRemaining({ startedAt: AT(0), now: AT(15), purchasedMinutes: 60 })).toBe(45 * 60);
  });

  it("floors at zero rather than going negative", () => {
    expect(secondsRemaining({ startedAt: AT(0), now: AT(75), purchasedMinutes: 60 })).toBe(0);
  });

  it("includes time that was added", () => {
    expect(
      secondsRemaining({ startedAt: AT(0), now: AT(70), purchasedMinutes: 60, extraMinutes: 30 }),
    ).toBe(20 * 60);
  });
});

describe("closing a session nobody is looking after", () => {
  const purchasedMinutes = 60;

  it("waits a generous window before calling it a no-show", () => {
    const readyAt = AT(0);
    const shared = { state: "READY" as const, readyAt, startedAt: null, purchasedMinutes };

    expect(autoCloseReason({ ...shared, now: AT(NO_SHOW_AFTER_MINUTES - 1) })).toBeNull();
    expect(autoCloseReason({ ...shared, now: AT(NO_SHOW_AFTER_MINUTES) })).toBe("NO_SHOW");
  });

  it("distinguishes a no-show from an overrun, because the money differs", () => {
    // Nothing was delivered.
    expect(
      autoCloseReason({
        state: "READY",
        readyAt: AT(0),
        startedAt: null,
        now: AT(30),
        purchasedMinutes,
      }),
    ).toBe("NO_SHOW");

    // Everything was delivered; only the clock ran out.
    expect(
      autoCloseReason({
        state: "ACTIVE",
        readyAt: AT(0),
        startedAt: AT(0),
        now: AT(purchasedMinutes + OVERRUN_GRACE_MINUTES),
        purchasedMinutes,
      }),
    ).toBe("OVERRAN");
  });

  it("leaves a session inside its grace period alone", () => {
    expect(
      autoCloseReason({
        state: "ACTIVE",
        readyAt: AT(0),
        startedAt: AT(0),
        now: AT(purchasedMinutes + OVERRUN_GRACE_MINUTES - 1),
        purchasedMinutes,
      }),
    ).toBeNull();
  });

  it("counts added time before deciding a session overran", () => {
    expect(
      autoCloseReason({
        state: "ACTIVE",
        readyAt: AT(0),
        startedAt: AT(0),
        now: AT(purchasedMinutes + OVERRUN_GRACE_MINUTES + 5),
        purchasedMinutes,
        extraMinutes: 30,
      }),
    ).toBeNull();
  });

  it("never closes a session that has already ended", () => {
    for (const state of ["COMPLETED", "ABANDONED"] as const) {
      expect(
        autoCloseReason({
          state,
          readyAt: AT(0),
          startedAt: AT(0),
          now: AT(999),
          purchasedMinutes,
        }),
      ).toBeNull();
    }
  });
});

describe("who is in this session", () => {
  const ids = { customerUserId: "user_customer", expertUserId: "user_expert" };

  it("recognises both participants", () => {
    expect(participantRole({ ...ids, actorUserId: "user_customer" })).toBe("CUSTOMER");
    expect(participantRole({ ...ids, actorUserId: "user_expert" })).toBe("EXPERT");
  });

  it("recognises nobody else — including an admin", () => {
    // Deliberate: an admin may read a session through the audit surfaces, but
    // being staff is not a reason to be handed a token that joins a live call
    // between two other people.
    expect(participantRole({ ...ids, actorUserId: "user_admin" })).toBeNull();
  });
});
