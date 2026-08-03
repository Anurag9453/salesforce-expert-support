import { can } from "@sfx/domain";
import { getContainer } from "@/lib/container";
import { buildMatchingAudit } from "@/lib/matching-view";
import { apiFail, apiOk, handleRoute } from "@/lib/route-helpers";
import { requireActor } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Requirement 4 — "why was Expert B selected instead of Expert A?"
 *
 * Every run for this request, oldest first, each with the weights and floors that
 * were in force at the time and every candidate it considered: ranked with their
 * score components, excluded with their reasons. Reading it top to bottom is
 * reading the search as it actually happened.
 *
 * Nothing is recomputed. A weight change next month cannot rewrite the reasoning
 * behind a decision made today, because the snapshot lives on the run (§C7).
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const actor = await requireActor();
    if (!can(actor, "matching:read_audit")) {
      return apiFail("FORBIDDEN", "Matching audit is admin-only.");
    }

    const { id } = await ctx.params;
    const audit = await buildMatchingAudit(getContainer().prisma, id);
    if (!audit) return apiFail("NOT_FOUND", "No such request.");
    return apiOk(audit);
  });
}
