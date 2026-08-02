import { describe, expect, it } from "vitest";
import { add, CurrencyMismatchError, money, splitFee, subtract, zero } from "./money.js";

describe("money", () => {
  it("rejects non-integer amounts", () => {
    // The failure mode this prevents: someone passing rupees instead of paise.
    expect(() => money(10.5, "INR")).toThrow(TypeError);
    expect(() => money(1000, "INR")).not.toThrow();
  });

  it("refuses to combine different currencies", () => {
    expect(() => add(money(100, "INR"), money(100, "USD"))).toThrow(CurrencyMismatchError);
    expect(() => subtract(money(100, "INR"), money(100, "USD"))).toThrow(CurrencyMismatchError);
  });

  it("adds and subtracts within a currency", () => {
    expect(add(money(1000, "INR"), money(500, "INR")).amountMinor).toBe(1500);
    expect(subtract(money(1000, "INR"), money(500, "INR")).amountMinor).toBe(500);
    expect(zero("INR").amountMinor).toBe(0);
  });
});

describe("splitFee", () => {
  it("splits a clean 25% with no remainder", () => {
    const { platformFee, expertPayout } = splitFee(money(100_000, "INR"), 2500);
    expect(platformFee.amountMinor).toBe(25_000);
    expect(expertPayout.amountMinor).toBe(75_000);
  });

  it("never loses or invents a minor unit, across the whole range", () => {
    // This is the property that matters: the payout is the remainder, not an
    // independent calculation, so the two halves always reconcile exactly.
    const bpsValues = [0, 1, 999, 2000, 2500, 3333, 6667, 9999, 10_000];
    for (let gross = 1; gross <= 2000; gross++) {
      for (const bps of bpsValues) {
        const { platformFee, expertPayout } = splitFee(money(gross, "INR"), bps);
        expect(platformFee.amountMinor + expertPayout.amountMinor).toBe(gross);
        expect(platformFee.amountMinor).toBeGreaterThanOrEqual(0);
        expect(expertPayout.amountMinor).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("handles the degenerate amounts", () => {
    expect(splitFee(money(0, "INR"), 2500).platformFee.amountMinor).toBe(0);
    expect(splitFee(money(1, "INR"), 10_000).expertPayout.amountMinor).toBe(0);
    expect(splitFee(money(1, "INR"), 0).platformFee.amountMinor).toBe(0);
  });

  it("rejects an out-of-range or non-integer fee rate", () => {
    expect(() => splitFee(money(100, "INR"), -1)).toThrow(RangeError);
    expect(() => splitFee(money(100, "INR"), 10_001)).toThrow(RangeError);
    expect(() => splitFee(money(100, "INR"), 12.5)).toThrow(RangeError);
  });

  it("rejects splitting a negative amount", () => {
    expect(() => splitFee(money(-100, "INR"), 2500)).toThrow(RangeError);
  });
});
