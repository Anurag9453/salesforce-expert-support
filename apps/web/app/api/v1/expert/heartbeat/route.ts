import { toAvailabilityView } from "@/lib/availability-view";
import { getContainer } from "@/lib/container";
import { apiOk, handleRoute } from "@/lib/route-helpers";
import { requireActor } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Presence ping (§C4, requirement 5).
 *
 * POST because it writes, and takes no body: there is nothing for a client to
 * assert here. Notably it cannot make an expert available — the service records
 * a timestamp and never touches status, so an expert already swept offline goes
 * on pinging and stays offline until they say otherwise.
 *
 * It returns the full availability view rather than an empty 204 precisely so
 * that a client which has been swept finds out on its very next ping, without
 * needing a second request to notice.
 */
export async function POST() {
  return handleRoute(async () => {
    const actor = await requireActor();
    const view = await getContainer().expertAvailability.heartbeat(actor);
    return apiOk(toAvailabilityView(view));
  });
}
