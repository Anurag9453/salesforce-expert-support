import type { CurrencyCode } from "@sfx/contracts";

/**
 * What an expert owes the platform, and when they stop being able to take work.
 *
 * ## The model
 *
 * Two revenue streams, and only one of them is a percentage:
 *
 *   1. A **platform fee** on every session — 10%, taken at capture, deducted
 *      before payout. Lives in `splitFee`, not here.
 *   2. A **usage fee** the expert owes after every fifth session they deliver.
 *
 * The second one is deliberately *not* a subscription. An expert pays nothing to
 * be on the platform, nothing to be matched, and nothing for sessions they were
 * offered and did not get. The fee falls due only after work has actually been
 * delivered and earned from — which is the whole pitch against buying connects
 * up front and watching them expire unused.
 *
 * ## Why it is not a percentage
 *
 * Because per-transaction revenue is the part card processing eats. A fixed
 * ~2.9% + 30¢ takes roughly 44% of a 10% fee on a $20 session. A flat fee billed
 * once per five sessions is charged once rather than five times, so almost all of
 * it survives.
 *
 * The trade-off is that a flat fee is regressive: £5 is 6% of a 30-minute session
 * and 2.4% of a two-hour one. That is a known and accepted property, recorded
 * here so nobody later "fixes" it by accident.
 *
 * ## No exchange rates
 *
 * Three independently-chosen amounts, not one converted three ways. The platform
 * holds no FX position anywhere and this is not the place to introduce one — see
 * the currency rule in the architecture notes.
 */

/** Sessions delivered before one fee unit falls due. Exactly five, never a range. */
export const SESSIONS_PER_FEE_UNIT = 5;

/**
 * One fee unit, in minor units, per currency.
 *
 * Set per market rather than converted. Adding a currency means choosing a
 * number for it, which is the intended friction: a missing entry is a compile
 * error at the call site rather than a silent conversion.
 */
export const EXPERT_FEE_MINOR: Partial<Record<CurrencyCode, number>> = {
  INR: 50_000, // ₹500
  USD: 600, // $6
  GBP: 500, // £5
};

/** Whether we can bill an expert in this currency at all. */
export function supportsExpertFee(currency: CurrencyCode): boolean {
  return EXPERT_FEE_MINOR[currency] !== undefined;
}

/**
 * The fee for one unit in the given currency.
 *
 * Throws rather than defaulting. A currency with no chosen price must stop the
 * operation, because every fallback here is either a wrong charge or an invented
 * exchange rate.
 */
export function expertFeeUnit(currency: CurrencyCode): number {
  const amount = EXPERT_FEE_MINOR[currency];
  if (amount === undefined) {
    throw new RangeError(
      `No expert fee is set for ${currency}. Choose one — it must not be converted from another currency.`,
    );
  }
  return amount;
}

/**
 * How many fee units an expert has accrued in total across their whole history.
 *
 * Derived from the session count rather than incremented, so it cannot drift: a
 * replayed session-completion event recomputes the same number instead of
 * double-charging. That is the same idempotency reasoning the dispatch signals
 * use — compute from state, never accumulate from events.
 */
export function feeUnitsAccrued(sessionsDelivered: number): number {
  if (sessionsDelivered <= 0) return 0;
  return Math.floor(sessionsDelivered / SESSIONS_PER_FEE_UNIT);
}

/**
 * What has newly fallen due since we last billed them.
 *
 * Returns zero rather than a negative number when the billed count is somehow
 * ahead — an over-billed expert is a support conversation, not something to
 * silently correct by issuing a credit nobody asked for.
 */
export function feeUnitsNewlyDue(params: {
  readonly sessionsDelivered: number;
  readonly feeUnitsAlreadyBilled: number;
}): number {
  const accrued = feeUnitsAccrued(params.sessionsDelivered);
  return Math.max(0, accrued - params.feeUnitsAlreadyBilled);
}

/** Sessions still to deliver before the next fee falls due. Drives the expert's UI. */
export function sessionsUntilNextFee(sessionsDelivered: number): number {
  const into = Math.max(0, sessionsDelivered) % SESSIONS_PER_FEE_UNIT;
  return SESSIONS_PER_FEE_UNIT - into;
}

// ── Outstanding dues, and being blocked by them ──────────────────────────────

/**
 * Why someone owes the platform money.
 *
 * Both sides of the marketplace can hold dues, and both are blocked by them, so
 * the concept is shared rather than duplicated per case:
 *
 *   - `EXPERT_USAGE_FEE` — the per-five-sessions fee above.
 *   - `SESSION_EXTENSION` — a customer extended a live call and was billed
 *     afterwards rather than interrupted for payment mid-session.
 *
 * One rule with two sources, not two rules. A second implementation of "are they
 * blocked?" is how one of them ends up enforced and the other quietly not.
 */
export type DueReason = "EXPERT_USAGE_FEE" | "SESSION_EXTENSION";

export interface OutstandingDue {
  readonly reason: DueReason;
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
}

export interface DuesVerdict {
  readonly blocked: boolean;
  /** Totals per currency. Never summed across currencies — there is no rate to do it with. */
  readonly totals: ReadonlyArray<{ currency: CurrencyCode; amountMinor: number }>;
  readonly reasons: readonly DueReason[];
}

/**
 * Whether outstanding dues should stop someone starting anything new.
 *
 * Any unpaid due blocks. There is deliberately no grace threshold: a floor like
 * "blocked over $10" is a number someone has to defend, and the amounts here are
 * small enough that the honest rule is simply "settle it".
 *
 * Totals are reported per currency because they cannot be added together. An
 * expert with ₹500 and $6 outstanding owes two things, not one converted thing.
 */
export function evaluateDues(dues: readonly OutstandingDue[]): DuesVerdict {
  const unpaid = dues.filter((due) => due.amountMinor > 0);

  const byCurrency = new Map<CurrencyCode, number>();
  for (const due of unpaid) {
    byCurrency.set(due.currency, (byCurrency.get(due.currency) ?? 0) + due.amountMinor);
  }

  return {
    blocked: unpaid.length > 0,
    totals: [...byCurrency.entries()].map(([currency, amountMinor]) => ({ currency, amountMinor })),
    // Deduplicated and ordered, so the copy shown to the user is stable rather
    // than reflecting whatever order the rows came back in.
    reasons: [...new Set(unpaid.map((due) => due.reason))].sort(),
  };
}

/**
 * The sentence to show whoever is blocked.
 *
 * Says what is owed and why, and never implies wrongdoing — an expert who has
 * delivered five sessions and owes £5 has done exactly what we wanted.
 */
export function duesMessage(
  verdict: DuesVerdict,
  format: (minor: number, c: CurrencyCode) => string,
): string | null {
  if (!verdict.blocked) return null;
  const amounts = verdict.totals
    .map((total) => format(total.amountMinor, total.currency))
    .join(" and ");
  const because = verdict.reasons.includes("SESSION_EXTENSION")
    ? verdict.reasons.includes("EXPERT_USAGE_FEE")
      ? "an extended session and your platform fee"
      : "an extended session"
    : "your platform fee";
  return `${amounts} is outstanding for ${because}. Settle it to carry on.`;
}
