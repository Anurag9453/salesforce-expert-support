import { createSupportLeadSchema } from "@sfx/contracts";
import { isAuthenticated, RATE_LIMITS, zonedWallClockToUtc } from "@sfx/domain";
import { getContainer } from "@/lib/container";
import { enforceRateLimit } from "@/lib/rate-limit";
import { apiOk, handleRoute, parseBody } from "@/lib/route-helpers";
import { getActor } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Capture an enquiry from a stranger.
 *
 * **Deliberately unauthenticated.** This is the one action the site exists to
 * collect, and a sign-up in front of it would lose most of the people who would
 * otherwise have asked. That decision costs the two protections a session
 * normally provides, so both are replaced:
 *
 *   - **Identity** becomes rate limiting by IP rather than by user. A weaker key
 *     — shared offices and mobile carriers sit behind one address — so the limit
 *     is sized to stop a script rather than a busy company.
 *   - **Trust in the input** becomes redaction, done by the service before
 *     anything is written. A public box is the likeliest place in the product
 *     for a password or a session id to be pasted.
 *
 * A signed-in customer submitting is still recognised, so their enquiry keeps an
 * owner — but nothing requires one.
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const forwarded = request.headers.get("x-forwarded-for");
    const ip = forwarded?.split(",")[0]?.trim() ?? "unknown";

    const limited = await enforceRateLimit(`lead:${ip}`, RATE_LIMITS.REQUEST_CREATE);
    if (limited) return limited;

    const body = await parseBody(request, createSupportLeadSchema);
    if (!body.ok) return body.response;

    const { supportLeads, pricing } = getContainer();

    // The quote is looked up server-side from the tier id. A price that arrives
    // in a request body is a price the sender chooses.
    const tier = body.data.pricingTierId
      ? await pricing.findTierById(body.data.pricingTierId)
      : null;

    // Anonymous is the normal case; a signed-in customer simply keeps their
    // owner. `isAuthenticated` is the domain's own narrowing, so this cannot
    // drift from what the rest of the app means by "signed in".
    const actor = await getActor();
    const customerId = isAuthenticated(actor) ? (actor.customerProfileId ?? null) : null;

    const lead = await supportLeads.submit({
      supportType: body.data.supportType,
      /*
        Converted here, not in the browser.

        The form sends the wall clock the customer typed plus the zone they chose,
        and the server resolves the instant. Doing it client-side would make the
        stored time depend on the visitor's own machine — including its clock
        being wrong — and a callback booked against a skewed browser is a call
        nobody takes.
      */
      preferredCallAt:
        body.data.preferredCallAt && body.data.preferredTimezone
          ? zonedWallClockToUtc({
              wallClock: body.data.preferredCallAt,
              timeZone: body.data.preferredTimezone,
            })
          : null,
      preferredTimezone: body.data.preferredTimezone ?? null,
      certification: body.data.certification ?? null,
      /*
        Parsed as UTC midnight rather than through the local `Date` constructor.
        `new Date("2026-09-12")` is already UTC midnight, but `new Date(2026, 8,
        12)` is midnight *wherever the server runs* — and the column is a DATE, so
        a server west of UTC would store the day before.
      */
      certificationExamOn: body.data.examDate ? new Date(`${body.data.examDate}T00:00:00Z`) : null,
      certificationHelp: body.data.certificationHelp ?? [],
      title: body.data.title ?? null,
      engagementCount: body.data.engagementCount ?? null,
      engagementUnit: body.data.engagementUnit ?? null,
      budgetBasis: body.data.budgetBasis ?? null,
      /*
        Whole currency in, minor units stored. Rounded rather than truncated: a
        budget typed as 62.505 becoming 62.50 is a rounding decision, and picking
        the one that does not quietly shave money off is free.
      */
      budgetAmountCents:
        body.data.budgetAmount === undefined ? null : Math.round(body.data.budgetAmount * 100),
      // Dollars, as the form says. Recorded explicitly rather than assumed, so a
      // second corridor later cannot silently reinterpret old rows.
      budgetCurrency: body.data.budgetAmount === undefined ? null : "USD",
      budgetNegotiable: body.data.budgetNegotiable,
      name: body.data.name,
      email: body.data.email,
      phone: body.data.phone,
      summary: body.data.summary,
      durationMinutes: tier?.durationMinutes ?? null,
      quotedPriceCents: tier?.priceCents ?? null,
      currency: tier?.currency ?? null,
      customerId,
    });

    // The id and a timestamp, nothing more. Echoing the stored contact details
    // back would make this endpoint a way to read what was submitted.
    return apiOk({ id: lead.id, receivedAt: lead.createdAt.toISOString() }, 201);
  });
}
