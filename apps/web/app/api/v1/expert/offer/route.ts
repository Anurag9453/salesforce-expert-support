import { respondToOfferSchema } from "@sfx/contracts";
import { getContainer } from "@/lib/container";
import { toOfferView } from "@/lib/matching-view";
import { apiFail, apiOk, handleRoute, parseBody } from "@/lib/route-helpers";
import { requireActor } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * The one thing currently awaiting this expert's yes or no.
 *
 * At most one exists: an expert holds at most one OFFERED attempt
 * (`one_open_offer_per_expert`), and a request has at most one CONFIRMING
 * attempt (`one_confirming_per_request`). The offer is checked first so that if
 * a deployment ever ran both dispatch modes at once, the mode that has already
 * locked the expert's availability wins.
 */
async function pendingDecisionFor(
  matchingRepo: ReturnType<typeof getContainer>["matchingRepo"],
  expertProfileId: string,
) {
  return (
    (await matchingRepo.findOpenOfferForExpert(expertProfileId)) ??
    (await matchingRepo.findPendingConfirmationForExpert(expertProfileId))
  );
}

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
 *
 * Answers for **both** dispatch modes. Under `exclusive` the question waiting on
 * an expert is an OFFERED attempt; under `interest_pool` it is a CONFIRMING one,
 * raised because a customer picked them off a shortlist. They are the same
 * question — "will you take this, and you have a countdown" — and
 * `startConfirmation` stores `offeredAt`/`offerExpiresAt` exactly as the offer
 * path does, so one view and one panel serve both. Giving the expert a second
 * screen that looked almost like this one would be the real duplication.
 */
export async function GET() {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { matchingRepo, requests, pricing, clock } = getContainer();

    if (!actor.expert) return apiOk(null);
    const attempt = await pendingDecisionFor(matchingRepo, actor.expert.profileId);
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

    const open = await pendingDecisionFor(matchingRepo, actor.expert.profileId);
    if (!open) return apiFail("CONFLICT", "You do not have an offer open right now.");

    // Same two buttons, different underlying transition. A confirmation is not
    // an offer acceptance: the customer has already chosen, so accepting settles
    // the request rather than starting a dispatch round, and declining hands the
    // customer back the rest of their shortlist instead of advancing a ranking.
    const confirming = open.status === "CONFIRMING";
    const attempt =
      body.data.decision === "accept"
        ? confirming
          ? await matching.confirmSelection(actor, open.id)
          : await matching.acceptOffer(actor, open.id)
        : confirming
          ? await matching.declineConfirmation(actor, open.id, body.data.reason ?? null)
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
