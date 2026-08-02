import { apiOk, handleRoute } from "@/lib/route-helpers";
import { getContainer } from "@/lib/container";
import { requireActor } from "@/lib/session";
import { toExpertApplicationView } from "@/lib/expert-view";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { id } = await ctx.params;
    const record = await getContainer().expertAdmin.get(actor, id);
    return apiOk(toExpertApplicationView(record));
  });
}
