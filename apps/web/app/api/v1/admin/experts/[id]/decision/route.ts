import { adminExpertDecisionSchema } from "@sfx/contracts";
import { apiOk, handleRoute, parseBody } from "@/lib/route-helpers";
import { getContainer } from "@/lib/container";
import { requireActor } from "@/lib/session";
import { toExpertApplicationView } from "@/lib/expert-view";

export const dynamic = "force-dynamic";

/**
 * Every administrative decision, in one place.
 *
 * A discriminated union rather than five endpoints, so the "a reason is
 * required" rule is expressed once in the schema and once in the domain, and
 * cannot be forgotten on the fifth route.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { id } = await ctx.params;
    const body = await parseBody(request, adminExpertDecisionSchema);
    if (!body.ok) return body.response;

    const { expertAdmin } = getContainer();
    const decision = body.data;

    const record = await (() => {
      switch (decision.decision) {
        case "claim":
          return expertAdmin.claimForReview(actor, id);
        case "approve":
          return expertAdmin.approve(actor, id, decision.notes, decision.verifiedCertifications);
        case "reject":
          return expertAdmin.reject(actor, id, decision.notes);
        case "suspend":
          return expertAdmin.suspend(actor, id, decision.notes);
        case "reinstate":
          return expertAdmin.reinstate(actor, id, decision.notes);
        default: {
          const never: never = decision;
          throw new Error(`Unhandled decision: ${JSON.stringify(never)}`);
        }
      }
    })();

    return apiOk(toExpertApplicationView(record));
  });
}
