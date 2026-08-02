import type { CurrencyCode } from "@sfx/contracts";

/**
 * Money as integer minor units. No floats anywhere in the money path (§27, §3).
 *
 * Everything here is total and side-effect free, so pricing and fee splits are
 * unit-testable without a database.
 */
export interface Money {
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
}

export class CurrencyMismatchError extends Error {
  constructor(a: CurrencyCode, b: CurrencyCode) {
    super(`Cannot combine ${a} and ${b}. Convert explicitly before arithmetic.`);
    this.name = "CurrencyMismatchError";
  }
}

export function money(amountMinor: number, currency: CurrencyCode): Money {
  if (!Number.isInteger(amountMinor)) {
    throw new TypeError(
      `Money must be integer minor units; received ${amountMinor}. ` +
        `Pass paise/cents, not rupees/dollars.`,
    );
  }
  return { amountMinor, currency };
}

export function zero(currency: CurrencyCode): Money {
  return { amountMinor: 0, currency };
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amountMinor: a.amountMinor - b.amountMinor, currency: a.currency };
}

export function isNegative(a: Money): boolean {
  return a.amountMinor < 0;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amountMinor === b.amountMinor;
}

/**
 * Split a gross amount into platform fee and expert payout.
 *
 * The fee is expressed in basis points (2000 = 20.00%) so the rate itself is an
 * integer. The payout is computed as the remainder rather than independently,
 * which is what guarantees `fee + payout === gross` exactly — no stray minor
 * unit can appear or vanish, whatever the rounding.
 */
export function splitFee(
  gross: Money,
  platformFeeBps: number,
): { platformFee: Money; expertPayout: Money } {
  if (!Number.isInteger(platformFeeBps) || platformFeeBps < 0 || platformFeeBps > 10_000) {
    throw new RangeError(`platformFeeBps must be an integer in [0, 10000]; got ${platformFeeBps}`);
  }
  if (gross.amountMinor < 0) {
    throw new RangeError("Cannot split a negative amount.");
  }

  // Round half-up on the fee, then derive the payout so the two always reconcile.
  const feeMinor = Math.floor((gross.amountMinor * platformFeeBps + 5_000) / 10_000);
  return {
    platformFee: { amountMinor: feeMinor, currency: gross.currency },
    expertPayout: { amountMinor: gross.amountMinor - feeMinor, currency: gross.currency },
  };
}

/** Display only. Never use the result for arithmetic or storage. */
export function formatMoney(value: Money, locale = "en-IN"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: value.currency,
    minimumFractionDigits: 2,
  }).format(value.amountMinor / 100);
}
