import { z } from "zod";
import { logTiming } from "@sfx/domain";
import { getContainer } from "@/lib/container";
import { apiOk, handleRoute } from "@/lib/route-helpers";
import { requireActor } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * The two timing points only the browser can measure (requirement 16).
 *
 * Server logs can say when an offer was persisted and when the signal was
 * published. They cannot say when a human could actually *see* it — that gap
 * includes the network, the SSE hop, the fetch, and React rendering, and it is
 * exactly the gap the Phase 6 assessment is about.
 *
 * Deliberately narrow: an enum of two points and a bounded number. A client
 * cannot write arbitrary strings into our logs, and it cannot report a timing
 * point for anyone but itself — the actor is taken from the session.
 */
const timingSchema = z.object({
  point: z.enum(["expert_reconciled", "customer_reconciled"]),
  supportRequestId: z.string().max(64).optional(),
  /** Milliseconds the client observed. Bounded so a bad clock cannot skew a chart. */
  observedLatencyMs: z.number().int().min(0).max(600_000).optional(),
  state: z.string().max(32).optional(),
});

export async function POST(request: Request) {
  return handleRoute(async () => {
    const actor = await requireActor();

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      // A malformed beacon is not worth a 400 the client will never read.
      return apiOk({ recorded: false });
    }

    const parsed = timingSchema.safeParse(raw);
    if (!parsed.success) return apiOk({ recorded: false });

    logTiming(getContainer().logger, parsed.data.point, {
      ...parsed.data,
      userId: actor.userId,
      source: "client",
    });
    return apiOk({ recorded: true });
  });
}
