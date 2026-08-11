/**
 * The interest pool and the shortlist the customer chooses from.
 *
 * This is the second dispatch model, sitting alongside the original exclusive
 * offer loop rather than replacing it. Where that one picks for the customer,
 * this one broadcasts, collects raised hands, and puts the best three in front
 * of them.
 *
 * ## Why ranking still decides who gets shown
 *
 * The customer picks from three, but they do not pick *which* three — and the
 * three are chosen by the same banded ranking that direct dispatch uses, not by
 * who clicked first. That matters: a pure first-come shortlist rewards whoever
 * had the tab open, which is uncorrelated with being right for the problem.
 * Competence still dominates by construction (`primaryBand` before
 * `finalScore`), and rating contributes through `finalScore` where it is one
 * weighted component among five rather than the whole answer.
 *
 * So the guarantee is narrower than it was, but it is still a guarantee: nobody
 * below the competence floor can appear on a shortlist, however good their
 * rating and however fast they clicked.
 *
 * ## Why interest is not commitment
 *
 * `INTERESTED` says "I would take this". It is deliberately cheap, and it binds
 * nobody: an expert can raise a hand on several requests. The commitment happens
 * later, when the customer picks them and they confirm within
 * `EXPERT_CONFIRM_SECONDS`. Until both sides have said yes, no money moves and
 * no availability is consumed.
 *
 * That ordering is what makes the shortlist safe to show. If interest were
 * binding we would have to hold three experts hostage while one customer
 * deliberated.
 */

import type { RankedCandidate } from "./rank.js";

/** How many candidates the customer sees. Three is a choice, not a menu. */
export const SHORTLIST_SIZE = 3;

/**
 * How long the chosen expert has to confirm before they are dropped.
 *
 * Short on purpose. The customer is already waiting, and a lapse costs them a
 * second decision rather than the whole request — so the right trade is to fail
 * fast and show them the remaining two.
 */
export const EXPERT_CONFIRM_SECONDS = 120;

/**
 * Stop waiting for more hands once this many have gone up.
 *
 * Equal to the shortlist size: a fourth raised hand cannot change what is shown
 * unless it outranks one already there, and waiting for that costs the customer
 * real seconds. Ranking still decides the order — this only decides when to
 * stop collecting.
 */
export const INTEREST_TARGET = SHORTLIST_SIZE;

export interface ShortlistDecision {
  /** Best first, at most `SHORTLIST_SIZE`. */
  readonly shortlisted: readonly RankedCandidate[];
  /** Ranked and interested, but beaten. Kept for the audit trail. */
  readonly reserves: readonly RankedCandidate[];
}

/**
 * Picks the shortlist from those who raised a hand.
 *
 * `ranked` must arrive in ranking order — this function preserves it rather than
 * re-sorting, so the shortlist can never disagree with the audit trail about who
 * was better. Anyone interested but not ranked is ignored: raising a hand cannot
 * get you past a filter you failed.
 */
export function selectShortlist(
  ranked: readonly RankedCandidate[],
  interestedExpertIds: Iterable<string>,
  size: number = SHORTLIST_SIZE,
): ShortlistDecision {
  const interested = new Set(interestedExpertIds);
  const eligible = ranked.filter((candidate) => interested.has(candidate.expertProfileId));
  return {
    shortlisted: eligible.slice(0, Math.max(0, size)),
    reserves: eligible.slice(Math.max(0, size)),
  };
}

/**
 * Whether we have waited long enough to show the customer something.
 *
 * Two ways to stop: enough hands are up, or the window has run out. The second
 * one is what stops a thin bench leaving the customer on a spinner — one
 * interested expert shown now beats three shown after the deadline has passed.
 */
export function shouldCloseInterestWindow(params: {
  readonly interestedCount: number;
  readonly windowElapsedSeconds: number;
  readonly windowSeconds: number;
  readonly target?: number;
}): boolean {
  const target = params.target ?? INTEREST_TARGET;
  if (params.interestedCount >= target) return true;
  return params.windowElapsedSeconds >= params.windowSeconds && params.interestedCount > 0;
}

/** The absolute instant the chosen expert's window shuts. Stored, never recomputed. */
export function confirmationDeadline(now: Date, seconds: number = EXPERT_CONFIRM_SECONDS): Date {
  return new Date(now.getTime() + seconds * 1000);
}

/**
 * The shortlist after someone lets their window lapse.
 *
 * Returned as data rather than mutated in place so the caller can tell the
 * difference between "two left, ask again" and "nobody left, search again" —
 * which are different transitions, and getting them the wrong way round strands
 * a customer on an empty screen.
 */
export function shortlistAfterLapse(
  shortlisted: readonly RankedCandidate[],
  lapsedExpertProfileId: string,
): { readonly remaining: readonly RankedCandidate[]; readonly exhausted: boolean } {
  const remaining = shortlisted.filter(
    (candidate) => candidate.expertProfileId !== lapsedExpertProfileId,
  );
  return { remaining, exhausted: remaining.length === 0 };
}

/**
 * Hours, from the minutes we store.
 *
 * Rounded down, and zero stays zero: an expert with 40 minutes delivered has not
 * done "1 hour", and rounding up to flatter someone on a card the customer is
 * spending money against would be a small lie in the one place it matters.
 */
export function hoursDelivered(minutesDelivered: number): number {
  return Math.floor(Math.max(0, minutesDelivered) / 60);
}

/**
 * The average to show on a card, or null when there is nothing honest to show.
 *
 * Deliberately NOT the shrunk rating used for matching. Shrinkage exists to stop
 * one five-star review outranking fifty four-star ones when the platform is
 * choosing; showing a customer a number that is not the average of the reviews
 * they can count would be misleading. The card shows the plain mean and the
 * count beside it, and lets the reader do the discounting themselves.
 */
export function displayRating(
  ratingSum: number,
  ratingCount: number,
): { readonly average: number; readonly count: number } | null {
  if (ratingCount <= 0) return null;
  return { average: Math.round((ratingSum / ratingCount) * 10) / 10, count: ratingCount };
}
