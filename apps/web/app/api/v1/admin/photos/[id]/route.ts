import { photoDecisionSchema } from "@sfx/contracts";
import { getContainer } from "@/lib/container";
import { apiOk, handleRoute, parseBody } from "@/lib/route-helpers";
import { requireActor } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Approve or reject a photo.
 *
 * A rejection carries a mandatory note. The schema enforces it and the service
 * enforces it again — an expert told only "rejected" cannot fix anything and
 * will upload the same photo again.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { id } = await params;

    const body = await parseBody(request, photoDecisionSchema);
    if (!body.ok) return body.response;

    const { expertPhotos } = getContainer();
    const decided = await expertPhotos.decide(
      actor,
      id,
      body.data.decision === "approve"
        ? { approve: true }
        : { approve: false, note: body.data.note },
    );

    return apiOk({ id: decided.id, status: decided.status, reviewNote: decided.reviewNote });
  });
}
