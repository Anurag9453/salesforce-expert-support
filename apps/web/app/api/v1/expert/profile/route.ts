import { updateExpertProfileSchema } from "@sfx/contracts";
import { getContainer } from "@/lib/container";
import { toExpertApplicationView } from "@/lib/expert-view";
import { apiOk, handleRoute, parseBody } from "@/lib/route-helpers";
import { requireActor } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  return handleRoute(async () => {
    const actor = await requireActor();
    const record = await getContainer().expertProfiles.getOwn(actor);
    return apiOk(toExpertApplicationView(record));
  });
}

/**
 * Edit your own profile, after approval as well as before (requirement 8).
 *
 * Three independent barriers stand between this handler and an administrative
 * field, in increasing order of how much they can be trusted:
 *
 *   1. `updateExpertProfileSchema` is `.strict()`, so `{"status":"APPROVED"}`
 *      is a 400 rather than a silently-dropped key. The caller is told no.
 *   2. `ExpertProfileService` filters to `SELF_EDITABLE_PROFILE_FIELDS` in the
 *      domain, so the guarantee survives a second transport that forgets step 1.
 *   3. The Prisma adapter builds its `data` object field by field and never
 *      spreads the input.
 *
 * The first is a courtesy; the second is the actual invariant, and it is the one
 * covered by tests that need no HTTP layer and no database.
 */
export async function PATCH(request: Request) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const body = await parseBody(request, updateExpertProfileSchema);
    if (!body.ok) return body.response;

    const record = await getContainer().expertProfiles.updateOwn(actor, body.data);
    return apiOk(toExpertApplicationView(record));
  });
}
