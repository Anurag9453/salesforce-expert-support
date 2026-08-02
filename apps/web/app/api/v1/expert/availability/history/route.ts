import { toAvailabilityLogView } from "@/lib/availability-view";
import { getContainer } from "@/lib/container";
import { apiOk, handleRoute } from "@/lib/route-helpers";
import { requireActor } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * The expert's own availability history.
 *
 * Exists so a sweep is never mysterious. "You were taken offline at 14:32
 * because we stopped hearing from your browser" is the difference between a
 * trustworthy system and one that seems to turn itself off — which matters most
 * for the very people whose income depends on being online.
 */
export async function GET(request: Request) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const raw = Number(new URL(request.url).searchParams.get("limit") ?? 50);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 200) : 50;

    const entries = await getContainer().expertAvailability.history(actor, limit);
    return apiOk(entries.map(toAvailabilityLogView));
  });
}
