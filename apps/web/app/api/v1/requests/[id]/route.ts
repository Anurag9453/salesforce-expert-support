import { apiOk, handleRoute } from "@/lib/route-helpers";
import { getContainer } from "@/lib/container";
import { toRequestView } from "@/lib/request-view";
import { requireActor } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { id } = await ctx.params;
    const { supportRequests, attachments, pricing } = getContainer();

    // Throws FORBIDDEN for anyone but the owner — ownership is checked against
    // the row, not the URL.
    const record = await supportRequests.getForCustomer(actor, id);
    const tier = await pricing.findTierById(record.pricingTierId);

    return apiOk(
      toRequestView(record, await attachments.listForRequest(id), tier?.durationMinutes ?? 30),
    );
  });
}
