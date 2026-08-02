import { apiOk, handleRoute } from "@/lib/route-helpers";
import { getContainer } from "@/lib/container";
import { requireActor } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Requirement 3 — who did what, when, to this application. */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { id } = await ctx.params;
    const entries = await getContainer().expertAdmin.history(actor, id);
    return apiOk(
      entries.map((entry) => ({
        id: entry.id,
        action: entry.action,
        actorUserId: entry.actorUserId,
        actorType: entry.actorType,
        before: entry.before,
        after: entry.after,
        createdAt: entry.createdAt.toISOString(),
      })),
    );
  });
}
