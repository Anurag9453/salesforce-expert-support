import { createSupportLeadSchema } from "@sfx/contracts";
import { isAuthenticated, RATE_LIMITS } from "@sfx/domain";
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
