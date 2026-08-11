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

/**
 * Split what the customer is charged into an expert payout and platform revenue,
 * where part of the price exists purely to cover card processing.
 *
 * ## Why the fee base is not the charged amount
 *
 * The platform keeps 10% of a session. That means it also keeps only 10% of any
 * price rise — so recovering an $0.88 processing charge by raising the price
 * would need the price to go up by $12.39, because the other 90% flows to the
 * expert. Price is a hopeless lever for a cost the platform alone bears.
 *
 * So the charged amount carries a **processing allowance** on top of the fee
 * base. The percentage applies to the base; the allowance goes wholly to the
 * platform. The customer covers processing, the expert's payout is completely
 * unaffected by it, and the platform's 10% arrives intact rather than eroded to
 * about 6%.
 *
 * It is deliberately part of the price and never a separate line at checkout.
 * A visible card surcharge is a regulated act — prohibited for consumers in the
 * UK, restricted on debit cards in India, and conditional in the US — whereas a
 * price is just a price everywhere.
 *
 * ## The invariant
 *
 * `expertPayout + platformTotal === charged`, exactly, always. The payout is
 * derived as a remainder rather than computed independently, so no minor unit
 * can appear or vanish however the rounding falls.
 */
export function splitSessionPrice(params: {
  readonly charged: Money;
  /** The part of `charged` that exists to cover processing. Platform keeps all of it. */
  readonly processingAllowanceMinor: number;
  readonly platformFeeBps: number;
}): {
  charged: Money;
  feeBase: Money;
  processingAllowance: Money;
  /** Percentage fee plus the whole allowance — what the platform actually keeps. */
  platformTotal: Money;
  expertPayout: Money;
} {
  const { charged, processingAllowanceMinor, platformFeeBps } = params;

  if (!Number.isInteger(processingAllowanceMinor) || processingAllowanceMinor < 0) {
    throw new RangeError(
      `processingAllowanceMinor must be a non-negative integer; got ${String(processingAllowanceMinor)}`,
    );
  }
  if (processingAllowanceMinor > charged.amountMinor) {
    // Would imply a negative fee base, and then a negative payout. Better to
    // fail loudly than to quietly pay an expert nothing.
    throw new RangeError("The processing allowance cannot exceed the amount charged.");
  }

  const feeBaseMinor = charged.amountMinor - processingAllowanceMinor;
  const { platformFee, expertPayout } = splitFee(
    { amountMinor: feeBaseMinor, currency: charged.currency },
    platformFeeBps,
  );

  return {
    charged,
    feeBase: { amountMinor: feeBaseMinor, currency: charged.currency },
    processingAllowance: { amountMinor: processingAllowanceMinor, currency: charged.currency },
    platformTotal: {
      amountMinor: platformFee.amountMinor + processingAllowanceMinor,
      currency: charged.currency,
    },
    expertPayout,
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
