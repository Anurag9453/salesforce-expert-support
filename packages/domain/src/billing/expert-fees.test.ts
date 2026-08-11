import { describe, expect, it } from "vitest";
import {
  duesMessage,
  evaluateDues,
  expertFeeUnit,
  EXPERT_FEE_MINOR,
  feeUnitsAccrued,
  feeUnitsNewlyDue,
  sessionsUntilNextFee,
  SESSIONS_PER_FEE_UNIT,
  supportsExpertFee,
} from "./expert-fees.js";

const money = (minor: number, currency: string) =>
  currency === "INR" ? `₹${String(minor / 100)}` : `${currency} ${String(minor / 100)}`;

describe("fee amounts", () => {
  it("is exactly five sessions, not a range", () => {
    expect(SESSIONS_PER_FEE_UNIT).toBe(5);
  });

  it("carries the three chosen amounts", () => {
    expect(EXPERT_FEE_MINOR.INR).toBe(50_000); // ₹500
    expect(EXPERT_FEE_MINOR.USD).toBe(600); // $6
    expect(EXPERT_FEE_MINOR.GBP).toBe(500); // £5
  });

  it("refuses a currency with no chosen price rather than converting one", () => {
    // The whole point of the rule: a missing price must stop the operation. A
    // fallback here would be either a wrong charge or an invented exchange rate.
    expect(supportsExpertFee("EUR")).toBe(false);
    expect(() => expertFeeUnit("EUR")).toThrow(/must not be converted/i);
  });

  it("returns the amount for a supported currency", () => {
    expect(expertFeeUnit("GBP")).toBe(500);
  });
});

describe("accrual", () => {
  it("charges nothing until the fifth session is delivered", () => {
    for (const delivered of [0, 1, 2, 3, 4]) {
      expect(feeUnitsAccrued(delivered), `after ${String(delivered)}`).toBe(0);
    }
    expect(feeUnitsAccrued(5)).toBe(1);
  });

  it("accrues one unit per five, not per session", () => {
    expect(feeUnitsAccrued(9)).toBe(1);
    expect(feeUnitsAccrued(10)).toBe(2);
    expect(feeUnitsAccrued(24)).toBe(4);
    expect(feeUnitsAccrued(25)).toBe(5);
  });

  it("treats a negative or zero count as nothing owed", () => {
    expect(feeUnitsAccrued(0)).toBe(0);
    expect(feeUnitsAccrued(-3)).toBe(0);
  });

  it("is derived from the session count, so a replayed completion cannot double-charge", () => {
    // Computed from state rather than incremented per event — the same
    // idempotency property the dispatch signals rely on.
    const first = feeUnitsNewlyDue({ sessionsDelivered: 5, feeUnitsAlreadyBilled: 0 });
    expect(first).toBe(1);
    const replayed = feeUnitsNewlyDue({ sessionsDelivered: 5, feeUnitsAlreadyBilled: 1 });
    expect(replayed).toBe(0);
  });

  it("bills the backlog when several sessions land before we invoice", () => {
    expect(feeUnitsNewlyDue({ sessionsDelivered: 17, feeUnitsAlreadyBilled: 1 })).toBe(2);
  });

  it("never issues a credit when the billed count runs ahead", () => {
    // An over-billed expert is a support conversation, not something to silently
    // correct with a credit nobody asked for.
    expect(feeUnitsNewlyDue({ sessionsDelivered: 5, feeUnitsAlreadyBilled: 3 })).toBe(0);
  });

  it("counts down to the next fee for the expert's dashboard", () => {
    expect(sessionsUntilNextFee(0)).toBe(5);
    expect(sessionsUntilNextFee(1)).toBe(4);
    expect(sessionsUntilNextFee(4)).toBe(1);
    // Just billed: a full five to go again, not zero.
    expect(sessionsUntilNextFee(5)).toBe(5);
    expect(sessionsUntilNextFee(7)).toBe(3);
  });
});

describe("outstanding dues", () => {
  it("does not block an expert who owes nothing", () => {
    const verdict = evaluateDues([]);
    expect(verdict.blocked).toBe(false);
    expect(verdict.totals).toEqual([]);
    expect(duesMessage(verdict, money)).toBeNull();
  });

  it("blocks on any unpaid amount, with no grace threshold", () => {
    // No "blocked over $10" floor: that is a number someone has to defend, and
    // these amounts are small enough that "settle it" is the honest rule.
    const verdict = evaluateDues([{ reason: "EXPERT_USAGE_FEE", amountMinor: 1, currency: "USD" }]);
    expect(verdict.blocked).toBe(true);
  });

  it("ignores settled rows", () => {
    expect(
      evaluateDues([{ reason: "EXPERT_USAGE_FEE", amountMinor: 0, currency: "USD" }]).blocked,
    ).toBe(false);
  });

  it("totals per currency and never across them", () => {
    // ₹500 plus $6 is two debts, not one converted debt. There is no rate in the
    // system to add them with, and inventing one here would be the FX exposure
    // the whole design avoids.
    const verdict = evaluateDues([
      { reason: "EXPERT_USAGE_FEE", amountMinor: 50_000, currency: "INR" },
      { reason: "SESSION_EXTENSION", amountMinor: 600, currency: "USD" },
      { reason: "EXPERT_USAGE_FEE", amountMinor: 600, currency: "USD" },
    ]);
    expect(verdict.totals).toHaveLength(2);
    expect(verdict.totals.find((t) => t.currency === "USD")?.amountMinor).toBe(1200);
    expect(verdict.totals.find((t) => t.currency === "INR")?.amountMinor).toBe(50_000);
  });

  it("reports each reason once, in a stable order", () => {
    const verdict = evaluateDues([
      { reason: "SESSION_EXTENSION", amountMinor: 100, currency: "USD" },
      { reason: "EXPERT_USAGE_FEE", amountMinor: 600, currency: "USD" },
      { reason: "SESSION_EXTENSION", amountMinor: 200, currency: "USD" },
    ]);
    expect(verdict.reasons).toEqual(["EXPERT_USAGE_FEE", "SESSION_EXTENSION"]);
  });

  it("explains both sources in one sentence when both apply", () => {
    const verdict = evaluateDues([
      { reason: "SESSION_EXTENSION", amountMinor: 1000, currency: "USD" },
      { reason: "EXPERT_USAGE_FEE", amountMinor: 600, currency: "USD" },
    ]);
    const message = duesMessage(verdict, money);
    expect(message).toContain("USD 16");
    expect(message).toContain("an extended session and your platform fee");
  });

  it("names only the source that applies", () => {
    const extension = evaluateDues([
      { reason: "SESSION_EXTENSION", amountMinor: 1000, currency: "USD" },
    ]);
    expect(duesMessage(extension, money)).toContain("an extended session");
    expect(duesMessage(extension, money)).not.toContain("platform fee");
  });

  it("does not imply wrongdoing", () => {
    // An expert who delivered five sessions and owes £5 did exactly what we
    // wanted. The copy should read as a reminder, not an accusation.
    const verdict = evaluateDues([
      { reason: "EXPERT_USAGE_FEE", amountMinor: 500, currency: "GBP" },
    ]);
    const message = duesMessage(verdict, money) ?? "";
    for (const word of ["overdue", "failed", "violation", "suspended"]) {
      expect(message.toLowerCase()).not.toContain(word);
    }
  });
});
