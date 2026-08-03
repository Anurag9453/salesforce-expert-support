import { respondToOfferSchema } from "@sfx/contracts";
import { getContainer } from "@/lib/container";
import { toOfferView } from "@/lib/matching-view";
import { apiFail, apiOk, handleRoute, parseBody } from "@/lib/route-helpers";
import { requireActor } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * The expert's current offer, if they have one.
 *
 * Returns `null` rather than 404 for "no offer right now" — that is the normal
 * state of an available expert, not an error, and a mobile client polling this
 * should not have to distinguish a miss from a failure.
 *
 * `secondsRemaining` is computed on the server from the stored `offerExpiresAt`,
 * so a client with a skewed clock still counts down to the right moment
 * (requirement 8).
 */
export async function GET() {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { matchingRepo, requests, pricing, clock } = getContainer();

    if (!actor.expert) return apiOk(null);
    const attempt = await matchingRepo.findOpenOfferForExpert(actor.expert.profileId);
    if (!attempt) return apiOk(null);

    const request = await requests.findById(attempt.supportRequestId);
    if (!request) return apiOk(null);
    const tier = await pricing.findTierById(request.pricingTierId);

    return apiOk(
      toOfferView({
        attempt,
        request,
        durationMinutes: tier?.durationMinutes ?? 30,
        now: clock.now(),
      }),
    );
  });
}

/**
 * Accept or decline (requirements 9 and 10).
 *
 * A discriminated union rather than two endpoints, so "a decline may carry a
 * reason and an accept may not" is expressed once in the schema. The reason is
 * optional on purpose: an expert who has to justify saying no starts saying yes
 * to work they should not take.
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const body = await parseBody(request, respondToOfferSchema);
    if (!body.ok) return body.response;

    const { matching, matchingRepo, requests, pricing, clock } = getContainer();
    if (!actor.expert) return apiFail("FORBIDDEN", "You do not have an expert profile.");

    const open = await matchingRepo.findOpenOfferForExpert(actor.expert.profileId);
    if (!open) return apiFail("CONFLICT", "You do not have an offer open right now.");

    const attempt =
      body.data.decision === "accept"
        ? await matching.acceptOffer(actor, open.id)
        : await matching.declineOffer(actor, open.id, {
            reason: body.data.reason ?? null,
            note: body.data.note ?? null,
          });

    const supportRequest = await requests.findById(attempt.supportRequestId);
    const tier = supportRequest ? await pricing.findTierById(supportRequest.pricingTierId) : null;

    return apiOk({
      decision: body.data.decision,
      status: attempt.status,
      supportRequestId: attempt.supportRequestId,
      offer:
        supportRequest && body.data.decision === "accept"
          ? toOfferView({
              attempt,
              request: supportRequest,
              durationMinutes: tier?.durationMinutes ?? 30,
              now: clock.now(),
            })
          : null,
    });
  });
}
