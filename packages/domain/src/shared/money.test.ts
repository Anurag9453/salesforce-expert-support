import { describe, expect, it } from "vitest";
import {
  add,
  CurrencyMismatchError,
  money,
  splitFee,
  splitSessionPrice,
  subtract,
  zero,
} from "./money.js";

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

describe("splitSessionPrice — the customer covers processing", () => {
  const usd = (amountMinor: number) => ({ amountMinor, currency: "USD" as const });

  it("keeps the allowance whole and applies the percentage only to the base", () => {
    // $21.00 charged: $20 base, $1.00 allowance, 10% platform fee.
    const result = splitSessionPrice({
      charged: usd(2100),
      processingAllowanceMinor: 100,
      platformFeeBps: 1000,
    });
    expect(result.feeBase.amountMinor).toBe(2000);
    expect(result.expertPayout.amountMinor).toBe(1800); // untouched by the allowance
    expect(result.platformTotal.amountMinor).toBe(300); // $2.00 fee + $1.00 allowance
  });

  it("leaves the expert's payout identical whatever the allowance", () => {
    // The whole point: an expert's earnings must not move because card
    // processing did. Same base, three different allowances, same payout.
    const payouts = [0, 100, 250].map(
      (allowance) =>
        splitSessionPrice({
          charged: usd(2000 + allowance),
          processingAllowanceMinor: allowance,
          platformFeeBps: 1000,
        }).expertPayout.amountMinor,
    );
    expect(payouts).toEqual([1800, 1800, 1800]);
  });

  it("reconciles exactly — payout plus platform equals what was charged", () => {
    // Every amount that could produce a rounding stray.
    for (let charged = 1; charged <= 600; charged += 7) {
      // Clamped: an allowance above the charge is a separate, tested error.
      for (const raw of [0, 1, 13, 97]) {
        const allowance = Math.min(raw, charged);
        const result = splitSessionPrice({
          charged: usd(charged),
          processingAllowanceMinor: allowance,
          platformFeeBps: 1000,
        });
        expect(
          result.expertPayout.amountMinor + result.platformTotal.amountMinor,
          `charged=${String(charged)} allowance=${String(allowance)}`,
        ).toBe(charged);
      }
    }
  });

  it("behaves exactly like splitFee when there is no allowance", () => {
    const withAllowance = splitSessionPrice({
      charged: usd(3500),
      processingAllowanceMinor: 0,
      platformFeeBps: 1000,
    });
    const plain = splitFee(usd(3500), 1000);
    expect(withAllowance.expertPayout).toEqual(plain.expertPayout);
    expect(withAllowance.platformTotal).toEqual(plain.platformFee);
  });

  it("refuses an allowance larger than the charge", () => {
    // Would imply a negative fee base and then a negative payout. Failing loudly
    // beats quietly paying an expert nothing.
    expect(() =>
      splitSessionPrice({
        charged: usd(500),
        processingAllowanceMinor: 600,
        platformFeeBps: 1000,
      }),
    ).toThrow(/cannot exceed/i);
  });

  it("refuses a negative or fractional allowance", () => {
    for (const bad of [-1, 1.5]) {
      expect(() =>
        splitSessionPrice({
          charged: usd(2100),
          processingAllowanceMinor: bad,
          platformFeeBps: 1000,
        }),
      ).toThrow(/non-negative integer/i);
    }
  });
});
