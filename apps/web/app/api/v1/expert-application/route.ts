import { expertApplicationDraftSchema } from "@sfx/contracts";
import { apiOk, handleRoute, parseBody } from "@/lib/route-helpers";
import { getContainer } from "@/lib/container";
import { requireActor } from "@/lib/session";
import { toExpertApplicationView } from "@/lib/expert-view";

export const dynamic = "force-dynamic";

/** The caller's own application. Authorization happens in the service. */
export async function GET() {
  return handleRoute(async () => {
    const actor = await requireActor();
    const record = await getContainer().expertApplications.getOwn(actor);
    return apiOk(toExpertApplicationView(record));
  });
}

/** Start an application. Idempotent — applying twice returns the one in flight. */
export async function POST() {
  return handleRoute(async () => {
    const actor = await requireActor();
    const record = await getContainer().expertApplications.start(actor);
    return apiOk(toExpertApplicationView(record), 201);
  });
}

/** Save wizard progress. Partial by design; completeness is checked at submit. */
export async function PATCH(request: Request) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const body = await parseBody(request, expertApplicationDraftSchema);
    if (!body.ok) return body.response;

    const record = await getContainer().expertApplications.saveDraft(actor, body.data);
    return apiOk(toExpertApplicationView(record));
  });
}
