import type {
  MatchingAttemptView,
  MatchingAuditView,
  MatchingRunView,
  OfferView,
  ShortlistCandidateView,
  ShortlistView,
} from "@sfx/contracts";
import type { MatchingAttemptRecord, SupportRequestRecord } from "@sfx/domain";
import type { PrismaClient } from "@sfx/db";
import type { LocalFileStorage } from "@sfx/adapters";
import { displayRating, hoursDelivered } from "@sfx/domain";
import { photoUrlFor } from "./photo-view.js";

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
  const isConfirmation = attempt.status === "CONFIRMING";

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
    isConfirmation,
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

// ── Interest pool ────────────────────────────────────────────────────────────

/**
 * What an expert sees about a request they have been asked to consider.
 *
 * Identical in content to an exclusive offer — already-redacted description, the
 * skills, the duration, their payout — because it is the same decision. The only
 * difference is that answering does not commit them.
 */
export async function toInterestOpportunityViews(params: {
  attempts: readonly MatchingAttemptRecord[];
  supportRequests: { findById(id: string): Promise<SupportRequestRecord | null> };
  pricing: { findTierById(id: string): Promise<{ durationMinutes: number } | null> };
  matching: unknown;
}): Promise<
  Array<{
    attemptId: string;
    supportRequestId: string;
    title: string;
    description: string;
    difficulty: string | null;
    skills: Array<{ slug: string; name: string; isPrimary: boolean }>;
    durationMinutes: number;
    payoutCents: number;
    currency: string;
  }>
> {
  const views = [];
  for (const attempt of params.attempts) {
    const request = await params.supportRequests.findById(attempt.supportRequestId);
    if (!request) continue;
    const tier = await params.pricing.findTierById(request.pricingTierId);
    views.push({
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
      durationMinutes: tier?.durationMinutes ?? 30,
      // What they would earn, never what the customer paid.
      payoutCents: request.quotedExpertPayoutCents,
      currency: request.currency,
    });
  }
  return views;
}

/**
 * The three cards a customer chooses between.
 *
 * The photo is fetched through `expertPhotos.approvedForMany`, which is the only
 * method that can return one — so a pending or rejected photo cannot reach a
 * customer here even by accident. Everything else on the card is either
 * published by the expert or derived from work they actually delivered.
 *
 * Deliberately absent: score, rank, and any trace of who else was considered.
 * Leaking the ordering would turn a choice into a recommendation the customer
 * feels obliged to follow.
 */
export async function toShortlistView(
  request: SupportRequestRecord,
  container: {
    interest: { shortlistFor(id: string): Promise<readonly MatchingAttemptRecord[]> };
    expertPhotos: {
      approvedForMany(ids: readonly string[]): Promise<ReadonlyMap<string, { storageKey: string }>>;
    };
    storage: LocalFileStorage;
    prisma: PrismaClient;
  },
): Promise<ShortlistView> {
  const attempts = await container.interest.shortlistFor(request.id);
  const expertIds = attempts.map((attempt) => attempt.expertProfileId);
  const photos = await container.expertPhotos.approvedForMany(expertIds);

  const profiles = await container.prisma.expertProfile.findMany({
    where: { id: { in: expertIds } },
    select: {
      id: true,
      yearsExperience: true,
      professionalSummary: true,
      sessionsCompleted: true,
      minutesDelivered: true,
      ratingSum: true,
      ratingCount: true,
      user: { select: { name: true } },
      skills: { select: { verified: true, skill: { select: { name: true, slug: true } } } },
    },
  });
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const requiredSlugs = new Set(request.skills.map((skill) => skill.slug));

  const confirming = attempts.find((attempt) => attempt.status === "CONFIRMING");

  const candidates: ShortlistCandidateView[] = [];
  for (const attempt of attempts) {
    const profile = byId.get(attempt.expertProfileId);
    if (!profile) continue;
    const photo = photos.get(attempt.expertProfileId);
    const rating = displayRating(profile.ratingSum, profile.ratingCount);

    candidates.push({
      attemptId: attempt.id,
      displayName: profile.user.name,
      photoUrl: photo ? await photoUrlFor(container.storage, photo.storageKey) : null,
      headline: profile.professionalSummary,
      yearsExperience: profile.yearsExperience,
      hoursDelivered: hoursDelivered(profile.minutesDelivered),
      sessionsCompleted: profile.sessionsCompleted,
      rating,
      // Only the skills this request actually needs — the card answers
      // "why them", not "everything they can do".
      matchedSkills: profile.skills
        .filter((entry) => requiredSlugs.has(entry.skill.slug))
        .map((entry) => ({ name: entry.skill.name, verified: entry.verified })),
    });
  }

  return {
    candidates,
    matchDeadlineAt: request.matchDeadlineAt.toISOString(),
    awaitingConfirmation:
      confirming && confirming.offerExpiresAt
        ? {
            attemptId: confirming.id,
            confirmExpiresAt: confirming.offerExpiresAt.toISOString(),
          }
        : null,
  };
}
