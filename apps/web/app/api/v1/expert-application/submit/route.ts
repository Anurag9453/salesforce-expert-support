import { apiOk, handleRoute } from "@/lib/route-helpers";
import { getContainer } from "@/lib/container";
import { requireActor } from "@/lib/session";
import { toExpertApplicationView } from "@/lib/expert-view";

export const dynamic = "force-dynamic";

/**
 * Submit for review.
 *
 * The domain re-checks completeness here; the wizard's readiness indicator is a
 * hint, not a gate. Submitting confers nothing beyond a place in the admin
 * queue — eligibility still requires approval (requirement 2).
 */
export async function POST() {
  return handleRoute(async () => {
    const actor = await requireActor();
    const record = await getContainer().expertApplications.submit(actor);
    return apiOk(toExpertApplicationView(record));
  });
}
