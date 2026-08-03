import { can } from "@sfx/domain";
import { getContainer } from "@/lib/container";
import { apiFail, apiOk, handleRoute } from "@/lib/route-helpers";
import { requireActor } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * The in-flight queue (§C5).
 *
 * What an operator needs to answer "is anything going wrong right now?" — every
 * request still being matched, how long it has left, which relaxation level it
 * reached, and how many experts have already passed on it. That is the difference
 * between seeing "3 experts timed out, currently at relaxation 2" and guessing.
 */
export async function GET() {
  return handleRoute(async () => {
    const actor = await requireActor();
    if (!can(actor, "admin:read_requests")) {
      return apiFail("FORBIDDEN", "Admin only.");
    }

    const { prisma } = getContainer();
    const rows = await prisma.supportRequest.findMany({
      where: { state: { in: ["CREATED", "CLASSIFYING", "SEARCHING", "OFFERED"] } },
      orderBy: { matchDeadlineAt: "asc" },
      take: 100,
      select: {
        id: true,
        title: true,
        state: true,
        createdAt: true,
        matchDeadlineAt: true,
        customer: { select: { user: { select: { email: true } } } },
        matchingRuns: {
          orderBy: { roundNumber: "desc" },
          take: 1,
          select: { relaxationLevel: true, roundNumber: true },
        },
        matchingAttempts: { select: { status: true } },
      },
    });

    const now = Date.now();
    return apiOk(
      rows.map((row) => {
        const attempts = row.matchingAttempts;
        return {
          id: row.id,
          title: row.title,
          state: row.state,
          customerEmail: row.customer.user.email,
          createdAt: row.createdAt.toISOString(),
          matchDeadlineAt: row.matchDeadlineAt.toISOString(),
          secondsRemaining: Math.max(0, Math.ceil((row.matchDeadlineAt.getTime() - now) / 1000)),
          relaxationLevel: row.matchingRuns[0]?.relaxationLevel ?? null,
          rounds: row.matchingRuns[0]?.roundNumber ?? 0,
          // The numbers that tell an operator whether to intervene.
          offered: attempts.filter((a) => a.status === "OFFERED").length,
          declined: attempts.filter((a) => a.status === "DECLINED").length,
          timedOut: attempts.filter((a) => a.status === "TIMED_OUT").length,
          excluded: attempts.filter((a) => a.status === "EXCLUDED").length,
        };
      }),
    );
  });
}
