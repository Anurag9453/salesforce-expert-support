import type {
  MatchingAttemptView,
  MatchingAuditView,
  MatchingRunView,
  OfferView,
} from "@sfx/contracts";
import type { MatchingAttemptRecord, SupportRequestRecord } from "@sfx/domain";
import type { PrismaClient } from "@sfx/db";

/**
 * Domain records → the two matching wire shapes.
 *
 * Deliberately two, with different contents. An expert receiving an offer is not
 * shown their score or their rank; an admin reviewing a decision is shown
 * everything. That asymmetry is a product decision, not an oversight: telling an
 * expert they were fourth choice costs the relationship and buys nothing, while
 * withholding it from the operator makes the system unaccountable.
 */

export function toOfferView(params: {
  attempt: MatchingAttemptRecord;
  request: SupportRequestRecord;
  durationMinutes: number;
  now: Date;
}): OfferView {
  const { attempt, request, now } = params;
  const expiresAt = attempt.offerExpiresAt ?? now;

  return {
    attemptId: attempt.id,
    supportRequestId: request.id,
    title: request.title,
    description: request.description,
    difficulty: request.difficulty,
    skills: request.skills.map((skill) => ({
      slug: skill.slug,
      name: skill.name,
      isPrimary: skill.isPrimary,
    })),
    durationMinutes: params.durationMinutes,
    // What they will earn, not what the customer paid. The platform fee is not
    // theirs to see on an offer screen.
    payoutCents: request.quotedExpertPayoutCents,
    currency: request.currency,
    offeredAt: (attempt.offeredAt ?? now).toISOString(),
    offerExpiresAt: expiresAt.toISOString(),
    // Derived from the stored deadline so a client with a skewed clock still
    // counts down to the right moment (requirement 8).
    secondsRemaining: Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / 1000)),
    origin: attempt.origin,
    // Requirement 13, from the expert's side: they get to know a human chose
    // them, and why. Hiding it would make a manual assignment feel algorithmic.
    adminNote: attempt.origin === "ALGORITHMIC" ? null : attempt.adminReason,
  };
}

// ── The admin's audit view ───────────────────────────────────────────────────

function toAttemptView(
  attempt: MatchingAttemptRecord,
  emailByProfileId: ReadonlyMap<string, string>,
): MatchingAttemptView {
  return {
    id: attempt.id,
    expertProfileId: attempt.expertProfileId,
    expertEmail: emailByProfileId.get(attempt.expertProfileId) ?? "(unknown)",
    origin: attempt.origin,
    rank: attempt.rank,
    status: attempt.status,
    scores: {
      skill: attempt.skillScore,
      experience: attempt.experienceScore,
      rating: attempt.ratingScore,
      fairness: attempt.fairnessScore,
      reliability: attempt.reliabilityScore,
      final: attempt.finalScore,
    },
    breakdown:
      Object.keys(attempt.scoreBreakdown).length > 0
        ? (attempt.scoreBreakdown as MatchingAttemptView["breakdown"])
        : null,
    exclusionReasons: attempt.exclusionReasons as MatchingAttemptView["exclusionReasons"],
    offeredAt: attempt.offeredAt?.toISOString() ?? null,
    offerExpiresAt: attempt.offerExpiresAt?.toISOString() ?? null,
    respondedAt: attempt.respondedAt?.toISOString() ?? null,
    responseSeconds: attempt.responseSeconds,
    declineReason: attempt.declineReason,
    declineNote: attempt.declineNote,
    adminReason: attempt.adminReason,
  };
}

/**
 * The whole search, assembled for one request.
 *
 * Reads top to bottom as the search happened: level 0 with everyone it excluded
 * and why, then each relaxation step re-ranking a widened pool, then the offer
 * that landed. Requirement 4 is satisfied by this page existing.
 */
export async function buildMatchingAudit(
  prisma: PrismaClient,
  supportRequestId: string,
): Promise<MatchingAuditView | null> {
  const request = await prisma.supportRequest.findUnique({
    where: { id: supportRequestId },
    select: {
      id: true,
      state: true,
      createdAt: true,
      matchDeadlineAt: true,
      assignedExpertId: true,
    },
  });
  if (!request) return null;

  const runs = await prisma.matchingRun.findMany({
    where: { supportRequestId },
    orderBy: { roundNumber: "asc" },
    include: {
      attempts: {
        orderBy: [{ rank: { sort: "asc", nulls: "last" } }, { finalScore: "desc" }],
        include: { expert: { select: { user: { select: { email: true } } } } },
      },
    },
  });

  const emailByProfileId = new Map<string, string>();
  for (const run of runs) {
    for (const attempt of run.attempts) {
      emailByProfileId.set(attempt.expertProfileId, attempt.expert.user.email);
    }
  }

  const runViews: MatchingRunView[] = runs.map((run) => ({
    id: run.id,
    roundNumber: run.roundNumber,
    relaxationLevel: run.relaxationLevel,
    filtersApplied: (run.filtersApplied ?? {}) as Record<string, unknown>,
    weightsSnapshot: (run.weightsSnapshot ?? {}) as Record<string, unknown>,
    candidatePoolSize: run.candidatePoolSize,
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    attempts: run.attempts.map((attempt) =>
      toAttemptView(
        {
          ...attempt,
          scoreBreakdown: (attempt.scoreBreakdown ?? {}) as Record<string, unknown>,
          exclusionReasons: attempt.exclusionReasons,
        },
        emailByProfileId,
      ),
    ),
  }));

  return {
    supportRequestId: request.id,
    state: request.state,
    createdAt: request.createdAt.toISOString(),
    matchDeadlineAt: request.matchDeadlineAt.toISOString(),
    assignedExpertId: request.assignedExpertId,
    runs: runViews,
  };
}
