import { respondToInterestSchema } from "@sfx/contracts";
import { apiOk, handleRoute, parseBody } from "@/lib/route-helpers";
import { getContainer } from "@/lib/container";
import { requireActor } from "@/lib/session";
import { toInterestOpportunityViews } from "@/lib/matching-view";

export const dynamic = "force-dynamic";

/**
 * What this expert has been asked about and not yet answered.
 *
 * Interest-pool mode only. In exclusive mode nothing ever reaches RANKED-and-
 * broadcast, so this is simply always empty rather than an error — the workspace
 * renders one panel either way.
 */
export async function GET() {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { interest, requests, pricing, matching } = getContainer();
    if (!interest) return apiOk({ items: [] });

    const attempts = await interest.opportunitiesFor(actor);
    return apiOk({
      items: await toInterestOpportunityViews({
        attempts,
        supportRequests: requests,
        pricing,
        matching,
      }),
    });
  });
}

/**
 * Raise a hand, or pass.
 *
 * Neither is a commitment: interest does not lock availability and a pass costs
 * no reliability. Answering twice is a no-op, so a double-clicked button does
 * not become a 409 the expert has to interpret.
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const url = new URL(request.url);
    const attemptId = url.searchParams.get("attemptId") ?? "";

    const body = await parseBody(request, respondToInterestSchema);
    if (!body.ok) return body.response;

    const { interest } = getContainer();
    if (!interest) return apiOk({ changed: false });

    return apiOk(await interest.respond(actor, attemptId, body.data.interested));
  });
}
