import { selectShortlistCandidateSchema } from "@sfx/contracts";
import { apiOk, handleRoute, parseBody } from "@/lib/route-helpers";
import { getContainer } from "@/lib/container";
import { requireActor } from "@/lib/session";
import { toShortlistView } from "@/lib/matching-view";

export const dynamic = "force-dynamic";

/**
 * The candidates a customer is choosing between.
 *
 * Ownership is checked against the request record, never inferred from the id
 * in the URL — one customer must not be able to read another's shortlist, and
 * the photo on each card is only ever an APPROVED one.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { id } = await params;
    const { supportRequests, interest } = getContainer();

    const record = await supportRequests.getForCustomer(actor, id);
    if (!interest)
      return apiOk({
        candidates: [],
        matchDeadlineAt: record.matchDeadlineAt.toISOString(),
        awaitingConfirmation: null,
      });

    return apiOk(await toShortlistView(record, getContainer()));
  });
}

/** The customer's pick, which opens that expert's two-minute window. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { id } = await params;

    const body = await parseBody(request, selectShortlistCandidateSchema);
    if (!body.ok) return body.response;

    const { matching } = getContainer();
    const chosen = await matching.selectCandidate(actor, id, body.data.attemptId);

    return apiOk({
      attemptId: chosen.id,
      confirmExpiresAt: chosen.offerExpiresAt?.toISOString() ?? null,
    });
  });
}
