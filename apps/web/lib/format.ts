import type { CurrencyCode } from "@sfx/contracts";

/**
 * One money formatter for the whole UI.
 *
 * There were three: two copies of a `formatPrice` helper pinned to `en-IN`, and
 * an offer panel that concatenated a literal `₹` in front of the number. The
 * literal was a real defect — `OfferView` carries a currency code, so a USD
 * offer rendered as rupees.
 *
 * The locale is pinned to `"en"` rather than left to the viewer. Two reasons:
 * the same string has to be produced on the server and on the client or React
 * reports a hydration mismatch, and `en-IN` applies lakh/crore grouping to every
 * currency including USD, which is wrong for a product billing worldwide. The
 * currency *symbol* still comes from the code, so USD renders as $ and INR as ₹.
 */
export function formatMoney(minorUnits: number, currency: CurrencyCode | string): string {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(minorUnits / 100);
}

/**
 * Durations in words. Seconds below 90 so a 60-second offer window never reads
 * as "1 minute" — and never as the "0 minutes" that a 10-second test window
 * produced before this existed.
 */
export function formatDuration(seconds: number): string {
  if (seconds < 90) return `${Math.max(0, Math.round(seconds))} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hours` : `${hours}h ${rest}m`;
}
