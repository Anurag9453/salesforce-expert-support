import { setAvailabilitySchema } from "@sfx/contracts";
import { toAvailabilityView } from "@/lib/availability-view";
import { getContainer } from "@/lib/container";
import { apiOk, handleRoute, parseBody } from "@/lib/route-helpers";
import { requireActor } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * The expert's own availability (§11).
 *
 * Plain JSON in both directions and no dependence on a rendered page
 * (requirement 9) — the same two calls back the web dashboard and will back the
 * mobile app.
 */

/** Current status plus the server's eligibility verdict and its reasons. */
export async function GET() {
  return handleRoute(async () => {
    const actor = await requireActor();
    const view = await getContainer().expertAvailability.getOwn(actor);
    return apiOk(toAvailabilityView(view));
  });
}

/**
 * Go available, or go offline.
 *
 * Requirement 3 is enforced in the service against the expert's *application
 * status*, read from the database — not from this body, and not from a role.
 * A DRAFT or SUSPENDED expert posting `{"available":true}` gets a 403.
 */
export async function PUT(request: Request) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const body = await parseBody(request, setAvailabilitySchema);
    if (!body.ok) return body.response;

    const view = await getContainer().expertAvailability.setAvailability(
      actor,
      body.data.available,
    );
    return apiOk(toAvailabilityView(view));
  });
}
