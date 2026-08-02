import { adminExpertListQuerySchema } from "@sfx/contracts";
import { apiFail, apiOk, handleRoute } from "@/lib/route-helpers";
import { getContainer } from "@/lib/container";
import { requireActor } from "@/lib/session";
import { toExpertApplicationView } from "@/lib/expert-view";

export const dynamic = "force-dynamic";

/** The review queue. Defaults to what still needs a decision, oldest first. */
export async function GET(request: Request) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const url = new URL(request.url);
    const parsed = adminExpertListQuerySchema.safeParse({
      status: url.searchParams.get("status") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
      cursor: url.searchParams.get("cursor") ?? undefined,
    });
    if (!parsed.success) return apiFail("VALIDATION_ERROR", "Invalid query.");

    const { expertAdmin } = getContainer();
    const page = parsed.data.status
      ? await expertAdmin.listByStatus(actor, parsed.data.status, parsed.data)
      : await expertAdmin.listPendingReview(actor, parsed.data);

    return apiOk({
      items: page.items.map(toExpertApplicationView),
      nextCursor: page.nextCursor ?? null,
    });
  });
}
