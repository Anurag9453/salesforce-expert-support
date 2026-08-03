import { adminDispatchSchema, type DispatchCandidateView } from "@sfx/contracts";
import { can } from "@sfx/domain";
import { getContainer } from "@/lib/container";
import { apiFail, apiOk, handleRoute, parseBody } from "@/lib/route-helpers";
import { requireActor } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Who an operator could dispatch to, with the algorithm's own verdict attached.
 *
 * Built from the latest matching run rather than from a fresh query, so the
 * operator sees exactly what the dispatcher saw — including the exclusion
 * reasons. `assignable` distinguishes "Assign would work" from "only Force
 * Assign can reach them", which is the difference between choosing a candidate
 * and overriding the rules.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const actor = await requireActor();
    if (!can(actor, "matching:admin_assign")) {
      return apiFail("FORBIDDEN", "Manual dispatch is admin-only.");
    }
    const { id } = await ctx.params;
    const { prisma, matchingRepo } = getContainer();

    const run = await matchingRepo.latestRunForRequest(id);
    if (!run) return apiOk([]);

    const attempts = await prisma.matchingAttempt.findMany({
      where: { matchingRunId: run.id },
      orderBy: [{ rank: { sort: "asc", nulls: "last" } }, { finalScore: "desc" }],
      include: {
        expert: {
          select: {
            status: true,
            availabilityStatus: true,
            user: { select: { email: true } },
          },
        },
      },
    });

    const candidates: DispatchCandidateView[] = attempts.map((attempt) => ({
      expertProfileId: attempt.expertProfileId,
      email: attempt.expert.user.email,
      availabilityStatus: attempt.expert.availabilityStatus,
      expertStatus: attempt.expert.status,
      finalScore: attempt.status === "EXCLUDED" ? null : attempt.finalScore,
      rank: attempt.rank,
      exclusionReasons: attempt.exclusionReasons as DispatchCandidateView["exclusionReasons"],
      // Assign keeps the ordinary rules; only Force Assign overrides them.
      assignable:
        attempt.status !== "EXCLUDED" &&
        attempt.expert.status === "APPROVED" &&
        attempt.expert.availabilityStatus === "AVAILABLE",
    }));

    return apiOk(candidates);
  });
}

/**
 * Assign, or Force Assign (requirement 12).
 *
 * Both write an audit row naming the admin and the reason, and both produce an
 * offer the expert must still accept. Force Assign overrides competence,
 * ranking, and even availability — it does not override consent, and there is no
 * parameter here that could.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { id } = await ctx.params;
    const body = await parseBody(request, adminDispatchSchema);
    if (!body.ok) return body.response;

    const { matching } = getContainer();
    const params = {
      supportRequestId: id,
      expertProfileId: body.data.expertProfileId,
      reason: body.data.reason,
    };

    const attempt =
      body.data.mode === "force"
        ? await matching.adminForceAssign(actor, params)
        : await matching.adminAssign(actor, params);

    return apiOk({
      attemptId: attempt.id,
      expertProfileId: attempt.expertProfileId,
      origin: attempt.origin,
      status: attempt.status,
      offerExpiresAt: attempt.offerExpiresAt?.toISOString() ?? null,
      note: "The expert must still accept. Manual dispatch does not bypass consent.",
    });
  });
}
