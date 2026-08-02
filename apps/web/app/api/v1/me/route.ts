import { ANONYMOUS } from "@sfx/domain";
import { apiOk, handleRoute } from "@/lib/route-helpers";
import { getActor, toSessionView } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Who am I, and what may I do? Permissions are for rendering, never for gating. */
export async function GET() {
  return handleRoute(async () => {
    const actor = await getActor();
    if (actor === ANONYMOUS) return apiOk(null);
    return apiOk(toSessionView(actor));
  });
}
