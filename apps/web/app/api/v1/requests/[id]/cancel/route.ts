import { cancelRequestSchema } from "@sfx/contracts";
import { apiOk, handleRoute, parseBody } from "@/lib/route-helpers";
import { getContainer } from "@/lib/container";
import { toRequestView } from "@/lib/request-view";
import { requireActor } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Cancels and voids the payment authorization. Legal only before acceptance. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { id } = await ctx.params;

    const body = await parseBody(request, cancelRequestSchema);
    if (!body.ok) return body.response;

    const { supportRequests, attachments, pricing } = getContainer();
    const record = await supportRequests.cancel(actor, id, body.data.reason);
    const tier = await pricing.findTierById(record.pricingTierId);

    return apiOk(
      toRequestView(record, await attachments.listForRequest(id), tier?.durationMinutes ?? 30),
    );
  });
}
