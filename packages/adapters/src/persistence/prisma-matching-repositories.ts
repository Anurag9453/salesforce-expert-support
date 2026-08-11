import type {
  AttemptOrigin,
  AttemptStatus,
  AvailabilityStatus,
  DeclineReasonCode,
  ExpertStatus,
} from "@sfx/contracts";
import type { PrismaClient, PrismaTransactionClient } from "@sfx/db";
import {
  ConflictError,
  type CandidateRepository,
  type CandidateRow,
  type MatchingAttemptRecord,
  type MatchingRepository,
  type MatchingRunRecord,
  type PersistRunInput,
} from "@sfx/domain";

type Db = PrismaClient | PrismaTransactionClient;

/** Same structural detection as the Phase 2 adapters — `instanceof` is unreliable
 * across the Next.js/worker boundary because the client class identity differs. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

// ── Candidate query ──────────────────────────────────────────────────────────

/**
 * "Every expert worth looking at", and no more opinion than that.
 *
 * The filter is `status = APPROVED` plus *having at least one of the required
 * skills*. Everything else — availability, presence, competence, rating,
 * language — is decided by the domain, on rows this query returned, so the
 * decision is explainable and the exclusion reasons are recorded.
 *
 * That means an offline expert comes back from the database and is excluded in
 * TypeScript. Deliberate: filtering them out in SQL would make them invisible to
 * the audit trail, and "why wasn't Priya offered this?" is the single most
 * common question an operator will ask.
 *
 * The one thing narrowed here is the skill join, because an expert with none of
 * the required skills can never qualify at any relaxation level, and pulling the
 * whole bench for every request would not survive a real roster.
 */
export class PrismaCandidateRepository implements CandidateRepository {
  constructor(private readonly db: Db) {}

  async findCandidates(params: {
    supportRequestId: string;
    requiredSkillIds: readonly string[];
    now: Date;
    limit: number;
  }): Promise<readonly CandidateRow[]> {
    const request = await this.db.supportRequest.findUnique({
      where: { id: params.supportRequestId },
      select: { customer: { select: { userId: true } } },
    });
    const customerUserId = request?.customer.userId ?? "";

    const startOfDay = new Date(params.now);
    startOfDay.setUTCHours(0, 0, 0, 0);

    const rows = await this.db.expertProfile.findMany({
      where: {
        status: "APPROVED",
        ...(params.requiredSkillIds.length > 0
          ? { skills: { some: { skillId: { in: [...params.requiredSkillIds] } } } }
          : {}),
      },
      take: params.limit,
      // Deterministic order so a re-run sees the same rows; the domain's seeded
      // tie-break then makes the *ranking* deterministic too.
      orderBy: [{ lastAssignedAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        userId: true,
        status: true,
        availabilityStatus: true,
        lastHeartbeatAt: true,
        lastAssignedAt: true,
        yearsExperience: true,
        ratingSum: true,
        ratingCount: true,
        offersReceived: true,
        offersAccepted: true,
        avgResponseSeconds: true,
        languages: true,
        user: { select: { status: true } },
        skills: {
          select: {
            skillId: true,
            proficiencyLevel: true,
            yearsExperience: true,
            verified: true,
            skill: { select: { slug: true, categoryId: true } },
          },
        },
        sessions: {
          where: { createdAt: { gte: startOfDay } },
          select: { id: true },
        },
      },
    });

    return rows.map((row) => ({
      candidate: {
        expertProfileId: row.id,
        userId: row.userId,
        skills: row.skills.map((skill) => ({
          skillId: skill.skillId,
          slug: skill.skill.slug,
          categoryId: skill.skill.categoryId,
          proficiencyLevel: skill.proficiencyLevel,
          yearsExperience: skill.yearsExperience,
          verified: skill.verified,
        })),
        yearsExperience: row.yearsExperience ?? 0,
        ratingSum: row.ratingSum,
        ratingCount: row.ratingCount,
        offersReceived: row.offersReceived,
        offersAccepted: row.offersAccepted,
        avgResponseSeconds: row.avgResponseSeconds,
        sessionsToday: row.sessions.length,
        // Null means never offered anything, which the scorer reads as
        // maximally idle rather than as zero.
        idleMinutes: row.lastAssignedAt
          ? Math.max(0, Math.floor((params.now.getTime() - row.lastAssignedAt.getTime()) / 60_000))
          : null,
        languages: row.languages,
      },
      expertStatus: row.status,
      accountStatus: row.user.status,
      availabilityStatus: row.availabilityStatus,
      lastHeartbeatAt: row.lastHeartbeatAt,
      customerUserId,
    }));
  }
}

// ── Runs and attempts ────────────────────────────────────────────────────────

const ATTEMPT_SELECT = {
  id: true,
  matchingRunId: true,
  supportRequestId: true,
  expertProfileId: true,
  origin: true,
  rank: true,
  status: true,
  skillScore: true,
  experienceScore: true,
  ratingScore: true,
  fairnessScore: true,
  reliabilityScore: true,
  finalScore: true,
  scoreBreakdown: true,
  exclusionReasons: true,
  offeredAt: true,
  offerExpiresAt: true,
  respondedAt: true,
  responseSeconds: true,
  declineReason: true,
  declineNote: true,
  adminReason: true,
  createdAt: true,
} as const;

type AttemptRow = {
  id: string;
  matchingRunId: string;
  supportRequestId: string;
  expertProfileId: string;
  origin: AttemptOrigin;
  rank: number | null;
  status: AttemptStatus;
  skillScore: number;
  experienceScore: number;
  ratingScore: number;
  fairnessScore: number;
  reliabilityScore: number;
  finalScore: number;
  scoreBreakdown: unknown;
  exclusionReasons: string[];
  offeredAt: Date | null;
  offerExpiresAt: Date | null;
  respondedAt: Date | null;
  responseSeconds: number | null;
  declineReason: DeclineReasonCode | null;
  declineNote: string | null;
  adminReason: string | null;
  createdAt: Date;
};

function toAttempt(row: AttemptRow): MatchingAttemptRecord {
  return {
    ...row,
    scoreBreakdown: (row.scoreBreakdown ?? {}) as Record<string, unknown>,
    exclusionReasons: row.exclusionReasons,
  };
}

type RunRow = {
  id: string;
  supportRequestId: string;
  roundNumber: number;
  relaxationLevel: number;
  candidatePoolSize: number;
  startedAt: Date;
  completedAt: Date | null;
};

export class PrismaMatchingRepository implements MatchingRepository {
  constructor(private readonly db: Db) {}

  /**
   * The run and every attempt row it produced, in one transaction.
   *
   * All-or-nothing on purpose: a run whose ranked attempts committed but whose
   * exclusions did not would be an audit trail that lies by omission, which is
   * worse than no audit trail because it looks complete.
   */
  async persistRun(input: PersistRunInput): Promise<MatchingRunRecord> {
    const run = await this.db.matchingRun.create({
      data: {
        supportRequestId: input.supportRequestId,
        roundNumber: input.roundNumber,
        relaxationLevel: input.relaxationLevel,
        weightsSnapshot: input.weightsSnapshot as never,
        thresholdsSnapshot: input.thresholdsSnapshot as never,
        candidatePoolSize: input.candidatePoolSize,
        filtersApplied: input.filtersApplied as never,
        startedAt: input.now,
        attempts: {
          create: [
            ...input.ranked.map((entry) => ({
              supportRequestId: input.supportRequestId,
              expertProfileId: entry.expertProfileId,
              origin: "ALGORITHMIC" as const,
              rank: entry.rank,
              status: "RANKED" as const,
              skillScore: entry.score.skillScore,
              experienceScore: entry.score.experienceScore,
              ratingScore: entry.score.ratingScore,
              fairnessScore: entry.score.fairnessScore,
              reliabilityScore: entry.score.reliabilityScore,
              finalScore: entry.score.finalScore,
              scoreBreakdown: entry.score.breakdown as never,
            })),
            ...input.excluded.map((entry) => ({
              supportRequestId: input.supportRequestId,
              expertProfileId: entry.expertProfileId,
              origin: "ALGORITHMIC" as const,
              rank: null,
              status: "EXCLUDED" as const,
              exclusionReasons: [...entry.reasons],
            })),
          ],
        },
      },
      select: {
        id: true,
        supportRequestId: true,
        roundNumber: true,
        relaxationLevel: true,
        candidatePoolSize: true,
        startedAt: true,
        completedAt: true,
      },
    });
    return run as RunRow;
  }

  async findRunById(id: string): Promise<MatchingRunRecord | null> {
    return this.db.matchingRun.findUnique({
      where: { id },
      select: RUN_SELECT,
    });
  }

  async latestRunForRequest(supportRequestId: string): Promise<MatchingRunRecord | null> {
    return this.db.matchingRun.findFirst({
      where: { supportRequestId },
      orderBy: { roundNumber: "desc" },
      select: RUN_SELECT,
    });
  }

  async nextRoundNumber(supportRequestId: string): Promise<number> {
    const last = await this.db.matchingRun.findFirst({
      where: { supportRequestId },
      orderBy: { roundNumber: "desc" },
      select: { roundNumber: true },
    });
    return (last?.roundNumber ?? 0) + 1;
  }

  async listAttemptsForRequest(
    supportRequestId: string,
  ): Promise<readonly MatchingAttemptRecord[]> {
    const rows = await this.db.matchingAttempt.findMany({
      where: { supportRequestId },
      orderBy: [{ createdAt: "asc" }, { rank: "asc" }],
      select: ATTEMPT_SELECT,
    });
    return rows.map((row) => toAttempt(row as AttemptRow));
  }

  async findAttemptById(id: string): Promise<MatchingAttemptRecord | null> {
    const row = await this.db.matchingAttempt.findUnique({ where: { id }, select: ATTEMPT_SELECT });
    return row ? toAttempt(row as AttemptRow) : null;
  }

  async findOpenOffer(supportRequestId: string): Promise<MatchingAttemptRecord | null> {
    const row = await this.db.matchingAttempt.findFirst({
      where: { supportRequestId, status: "OFFERED" },
      select: ATTEMPT_SELECT,
    });
    return row ? toAttempt(row as AttemptRow) : null;
  }

  async findOpenOfferForExpert(expertProfileId: string): Promise<MatchingAttemptRecord | null> {
    const row = await this.db.matchingAttempt.findFirst({
      where: { expertProfileId, status: "OFFERED" },
      select: ATTEMPT_SELECT,
    });
    return row ? toAttempt(row as AttemptRow) : null;
  }

  async findAttemptForExpertOnRequest(params: {
    expertProfileId: string;
    supportRequestId: string;
  }): Promise<MatchingAttemptRecord | null> {
    const row = await this.db.matchingAttempt.findFirst({
      where: {
        expertProfileId: params.expertProfileId,
        supportRequestId: params.supportRequestId,
      },
      orderBy: { createdAt: "desc" },
    });
    return row ? toAttempt(row) : null;
  }
  async listRespondedExpertIds(supportRequestId: string): Promise<readonly string[]> {
    const rows = await this.db.matchingAttempt.findMany({
      where: { supportRequestId, status: { in: ["DECLINED", "TIMED_OUT"] } },
      select: { expertProfileId: true },
      distinct: ["expertProfileId"],
    });
    return rows.map((row) => row.expertProfileId);
  }

  async nextRankedAttempt(params: {
    matchingRunId: string;
  }): Promise<MatchingAttemptRecord | null> {
    const run = await this.db.matchingRun.findUnique({
      where: { id: params.matchingRunId },
      select: { supportRequestId: true },
    });
    if (!run) return null;

    const responded = await this.listRespondedExpertIds(run.supportRequestId);

    const row = await this.db.matchingAttempt.findFirst({
      where: {
        matchingRunId: params.matchingRunId,
        status: "RANKED",
        ...(responded.length > 0 ? { expertProfileId: { notIn: [...responded] } } : {}),
      },
      orderBy: { rank: "asc" },
      select: ATTEMPT_SELECT,
    });
    return row ? toAttempt(row as AttemptRow) : null;
  }

  /**
   * The load-bearing write of the whole dispatch loop.
   *
   * Three things happen together or not at all:
   *
   *   1. the attempt moves RANKED → OFFERED — and this is the INSERT-shaped
   *      write the `one_open_offer_per_expert` partial unique index guards. If
   *      the expert already holds an offer, Postgres raises P2002 and we
   *      translate it to `ConflictError` for the service to handle by trying the
   *      next candidate.
   *   2. the expert's availability moves to ON_OFFER, **guarded on their current
   *      status**. An expert who went offline between ranking and dispatch fails
   *      this guard, we return null, and the service skips them
   *      (requirement 14).
   *   3. `offersReceived` is incremented, because they genuinely received one.
   *
   * Admin-originated attempts are allowed to lock an OFFLINE expert — that is
   * the force-assign case, where an operator has already reached them.
   */
  async openOffer(params: {
    attemptId: string;
    expertProfileId: string;
    now: Date;
    offerExpiresAt: Date;
  }): Promise<MatchingAttemptRecord | null> {
    const attempt = await this.db.matchingAttempt.findUnique({
      where: { id: params.attemptId },
      select: { status: true, origin: true },
    });
    if (!attempt || attempt.status !== "RANKED") return null;

    const allowedFrom: AvailabilityStatus[] =
      attempt.origin === "ALGORITHMIC" ? ["AVAILABLE"] : ["AVAILABLE", "OFFLINE"];

    const locked = await this.db.expertProfile.updateMany({
      where: { id: params.expertProfileId, availabilityStatus: { in: allowedFrom } },
      data: { availabilityStatus: "ON_OFFER" },
    });
    if (locked.count === 0) return null;

    try {
      const updated = await this.db.matchingAttempt.updateMany({
        where: { id: params.attemptId, status: "RANKED" },
        data: { status: "OFFERED", offeredAt: params.now, offerExpiresAt: params.offerExpiresAt },
      });
      if (updated.count === 0) {
        await this.releaseAvailability(params.expertProfileId, "AVAILABLE");
        return null;
      }
    } catch (error) {
      // The partial unique index rejected it: this expert was offered something
      // else microseconds ago. Undo the lock we just took and let the service
      // move on.
      await this.releaseAvailability(params.expertProfileId, "AVAILABLE");
      if (isUniqueViolation(error)) {
        throw new ConflictError("That expert already holds an open offer.", {
          expertProfileId: params.expertProfileId,
        });
      }
      throw error;
    }

    await this.db.expertProfile.update({
      where: { id: params.expertProfileId },
      data: { offersReceived: { increment: 1 } },
    });

    await this.db.expertAvailabilityLog.create({
      data: {
        expertProfileId: params.expertProfileId,
        fromStatus: null,
        toStatus: "ON_OFFER",
        source: attempt.origin === "ALGORITHMIC" ? "OFFER_LOCK" : "ADMIN",
        changedByUserId: null,
      },
    });

    return this.findAttemptById(params.attemptId);
  }

  /**
   * Records the outcome and releases the expert.
   *
   * `updateMany … WHERE status = 'OFFERED'` is what makes a decline racing a
   * timeout produce exactly one winner: the loser updates zero rows and gets
   * null back. A `WITHDRAWN` may also close a still-RANKED attempt, which is the
   * "we could not lock them, mark it and move on" path.
   *
   * `countAgainstReliability` is false for sweeps, supersessions and deadline
   * withdrawals. A presence problem or an operator's decision must never damage
   * an expert's acceptance rate — and since `offersReceived` was already
   * incremented at offer time, that means decrementing it back.
   */
  async closeOffer(params: {
    attemptId: string;
    expertProfileId: string;
    toStatus: Extract<
      AttemptStatus,
      "ACCEPTED" | "DECLINED" | "TIMED_OUT" | "SUPERSEDED" | "WITHDRAWN"
    >;
    now: Date;
    declineReason?: DeclineReasonCode | null;
    declineNote?: string | null;
    countAgainstReliability: boolean;
    releaseTo: AvailabilityStatus | null;
  }): Promise<MatchingAttemptRecord | null> {
    const current = await this.db.matchingAttempt.findUnique({
      where: { id: params.attemptId },
      select: { status: true, offeredAt: true },
    });
    if (!current) return null;

    const allowedFrom: AttemptStatus[] =
      params.toStatus === "WITHDRAWN" ? ["OFFERED", "RANKED"] : ["OFFERED"];
    if (!allowedFrom.includes(current.status)) return null;

    const responseSeconds = current.offeredAt
      ? Math.max(0, Math.round((params.now.getTime() - current.offeredAt.getTime()) / 1000))
      : null;

    const updated = await this.db.matchingAttempt.updateMany({
      where: { id: params.attemptId, status: { in: allowedFrom } },
      data: {
        status: params.toStatus,
        respondedAt: params.now,
        responseSeconds,
        declineReason: params.declineReason ?? null,
        declineNote: params.declineNote ?? null,
      },
    });
    if (updated.count === 0) return null;

    if (!params.countAgainstReliability && current.status === "OFFERED") {
      // Give back the offer we counted at lock time.
      await this.db.expertProfile.update({
        where: { id: params.expertProfileId },
        data: { offersReceived: { decrement: 1 } },
      });
    }

    if (params.releaseTo) {
      await this.releaseAvailability(params.expertProfileId, params.releaseTo, params.toStatus);
    }

    return this.findAttemptById(params.attemptId);
  }

  async supersedeRankedAttempts(params: { matchingRunId: string; now: Date }): Promise<number> {
    const result = await this.db.matchingAttempt.updateMany({
      where: { matchingRunId: params.matchingRunId, status: "RANKED" },
      data: { status: "SUPERSEDED", respondedAt: params.now },
    });
    return result.count;
  }

  async createAdminAttempt(params: {
    matchingRunId: string;
    supportRequestId: string;
    expertProfileId: string;
    origin: Extract<AttemptOrigin, "ADMIN_ASSIGN" | "ADMIN_FORCE_ASSIGN">;
    adminReason: string;
    now: Date;
  }): Promise<MatchingAttemptRecord> {
    // A manual assignment to an expert already in this run reuses their row
    // rather than colliding with `unique(matchingRunId, expertProfileId)`.
    const existing = await this.db.matchingAttempt.findUnique({
      where: {
        matchingRunId_expertProfileId: {
          matchingRunId: params.matchingRunId,
          expertProfileId: params.expertProfileId,
        },
      },
      select: { id: true },
    });

    const row = existing
      ? await this.db.matchingAttempt.update({
          where: { id: existing.id },
          data: {
            origin: params.origin,
            // Null: it bypassed the ranking by definition (requirement 13).
            rank: null,
            status: "RANKED",
            adminReason: params.adminReason,
            exclusionReasons: [],
            respondedAt: null,
            responseSeconds: null,
            declineReason: null,
            declineNote: null,
          },
          select: ATTEMPT_SELECT,
        })
      : await this.db.matchingAttempt.create({
          data: {
            matchingRunId: params.matchingRunId,
            supportRequestId: params.supportRequestId,
            expertProfileId: params.expertProfileId,
            origin: params.origin,
            rank: null,
            status: "RANKED",
            adminReason: params.adminReason,
          },
          select: ATTEMPT_SELECT,
        });

    return toAttempt(row as AttemptRow);
  }

  /**
   * Open offers held by an expert who should not be holding one (requirement 14).
   *
   * Two conditions, both meaning "this offer will never be answered": the expert
   * is no longer an approved active account, or their presence has gone stale
   * past the grace period. Phase 4's sweep deliberately left `ON_OFFER` rows
   * alone; this is what finally handles them.
   */
  async listOffersNeedingReconciliation(params: { staleBefore: Date; limit: number }): Promise<
    readonly {
      attempt: MatchingAttemptRecord;
      expertStatus: ExpertStatus;
      accountStatus: "ACTIVE" | "SUSPENDED" | "DELETED";
      availabilityStatus: AvailabilityStatus;
      lastHeartbeatAt: Date | null;
    }[]
  > {
    const rows = await this.db.matchingAttempt.findMany({
      where: {
        status: "OFFERED",
        expert: {
          OR: [
            { status: { not: "APPROVED" } },
            { user: { status: { not: "ACTIVE" } } },
            { lastHeartbeatAt: null },
            { lastHeartbeatAt: { lt: params.staleBefore } },
          ],
        },
      },
      take: params.limit,
      select: {
        ...ATTEMPT_SELECT,
        expert: {
          select: {
            status: true,
            availabilityStatus: true,
            lastHeartbeatAt: true,
            user: { select: { status: true } },
          },
        },
      },
    });

    return rows.map((row) => {
      const { expert, ...attempt } = row;
      return {
        attempt: toAttempt(attempt as AttemptRow),
        expertStatus: expert.status,
        accountStatus: expert.user.status,
        availabilityStatus: expert.availabilityStatus,
        lastHeartbeatAt: expert.lastHeartbeatAt,
      };
    });
  }

  async listStalledSearches(params: {
    stalledBefore: Date;
    limit: number;
  }): Promise<readonly string[]> {
    const rows = await this.db.supportRequest.findMany({
      where: {
        state: "SEARCHING",
        stateEnteredAt: { lt: params.stalledBefore },
        // Belt and braces: SEARCHING should never coexist with an open offer,
        // but if it somehow does, the offer's own timeout is the right handler.
        matchingAttempts: { none: { status: "OFFERED" } },
      },
      take: params.limit,
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  async completeRun(params: { matchingRunId: string; now: Date }): Promise<void> {
    await this.db.matchingRun.updateMany({
      where: { id: params.matchingRunId, completedAt: null },
      data: { completedAt: params.now },
    });
  }

  /**
   * Returns the expert's availability, guarded on them still being ON_OFFER.
   *
   * The guard matters: an expert who was swept OFFLINE while an offer was open
   * must not be silently put back into the pool by the offer closing.
   */
  private async releaseAvailability(
    expertProfileId: string,
    to: AvailabilityStatus,
    outcome?: AttemptStatus,
  ): Promise<void> {
    const released = await this.db.expertProfile.updateMany({
      where: { id: expertProfileId, availabilityStatus: "ON_OFFER" },
      data: { availabilityStatus: to },
    });
    if (released.count === 0) return;

    await this.db.expertAvailabilityLog.create({
      data: {
        expertProfileId,
        fromStatus: "ON_OFFER",
        toStatus: to,
        source:
          outcome === "ACCEPTED"
            ? "SESSION_START"
            : outcome === "WITHDRAWN" || outcome === "SUPERSEDED"
              ? "ADMIN"
              : "OFFER_RELEASED",
        changedByUserId: null,
      },
    });
  }
}

const RUN_SELECT = {
  id: true,
  supportRequestId: true,
  roundNumber: true,
  relaxationLevel: true,
  candidatePoolSize: true,
  startedAt: true,
  completedAt: true,
} as const;
