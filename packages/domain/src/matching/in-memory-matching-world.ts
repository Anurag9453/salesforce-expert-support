import type {
  AttemptOrigin,
  AttemptStatus,
  AvailabilityStatus,
  DeclineReasonCode,
  ExclusionReason,
  ExpertStatus,
  ProficiencyLevel,
} from "@sfx/contracts";
import { ConflictError } from "../shared/errors.js";
import type {
  Candidate,
  CandidateRepository,
  CandidateRow,
  MatchingAttemptRecord,
  MatchingRepository,
  MatchingRunRecord,
  PersistRunInput,
} from "../ports/matching-repositories.js";

/**
 * Fakes for the matching ports.
 *
 * These are not stubs. Each one models the invariant its Prisma counterpart
 * enforces in the database, because a test passing against a permissive fake
 * tells you nothing about production:
 *
 *   - `openOffer` throws `ConflictError` when the expert already holds an open
 *     offer, exactly as the `one_open_offer_per_expert` partial unique index
 *     does. The dispatch loop's "try the next candidate" path is unreachable
 *     without it.
 *   - `closeOffer` is guarded on the attempt still being OFFERED, so a decline
 *     racing a timeout produces one winner here too.
 *   - `openOffer` refuses an expert who is not AVAILABLE, mirroring the
 *     adapter's guarded UPDATE — that is requirement 14's pre-offer case.
 */

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${String(counter).padStart(4, "0")}`;
}

export function resetMatchingIds(): void {
  counter = 0;
}

// ── Candidate builder ────────────────────────────────────────────────────────

export interface FakeCandidateSpec {
  readonly id: string;
  readonly skills: Record<
    string,
    | ProficiencyLevel
    | [ProficiencyLevel, number]
    | { level: ProficiencyLevel; years?: number; verified?: boolean; category?: string }
  >;
  readonly yearsExperience?: number;
  readonly ratingSum?: number;
  readonly ratingCount?: number;
  readonly offersReceived?: number;
  readonly offersAccepted?: number;
  readonly avgResponseSeconds?: number | null;
  readonly sessionsToday?: number;
  readonly idleMinutes?: number | null;
  readonly languages?: readonly string[];
  readonly expertStatus?: ExpertStatus;
  readonly accountStatus?: "ACTIVE" | "SUSPENDED" | "DELETED";
  readonly availabilityStatus?: AvailabilityStatus;
  readonly lastHeartbeatAt?: Date | null;
  readonly categoryOf?: Record<string, string>;
}

/** Terse candidate construction so a scenario reads as a table, not as setup. */
export function candidate(spec: FakeCandidateSpec): Candidate {
  return {
    expertProfileId: spec.id,
    userId: `user_${spec.id}`,
    skills: Object.entries(spec.skills).map(([slug, value]) => {
      const detail =
        typeof value === "string"
          ? { level: value, years: 3, verified: false, category: undefined }
          : Array.isArray(value)
            ? { level: value[0], years: value[1], verified: false, category: undefined }
            : {
                level: value.level,
                years: value.years ?? 3,
                verified: value.verified ?? false,
                category: value.category,
              };
      return {
        skillId: slug,
        slug,
        categoryId: detail.category ?? spec.categoryOf?.[slug] ?? "cat_default",
        proficiencyLevel: detail.level,
        yearsExperience: detail.years,
        verified: detail.verified,
      };
    }),
    yearsExperience: spec.yearsExperience ?? 5,
    ratingSum: spec.ratingSum ?? 0,
    ratingCount: spec.ratingCount ?? 0,
    offersReceived: spec.offersReceived ?? 0,
    offersAccepted: spec.offersAccepted ?? 0,
    avgResponseSeconds: spec.avgResponseSeconds ?? null,
    sessionsToday: spec.sessionsToday ?? 0,
    idleMinutes: spec.idleMinutes ?? null,
    languages: spec.languages ?? ["en"],
  };
}

export function candidateRow(
  spec: FakeCandidateSpec,
  customerUserId = "user_customer",
): CandidateRow {
  return {
    candidate: candidate(spec),
    expertStatus: spec.expertStatus ?? "APPROVED",
    accountStatus: spec.accountStatus ?? "ACTIVE",
    availabilityStatus: spec.availabilityStatus ?? "AVAILABLE",
    // `null` means "explicitly stale". `undefined` — the default — means "as
    // fresh as the clock is when the query runs", which the repository fills in.
    // Without that, advancing a test's clock to reach a relaxation level would
    // also sweep the entire bench, and the test would pass for the wrong reason.
    lastHeartbeatAt: spec.lastHeartbeatAt === undefined ? FRESH : spec.lastHeartbeatAt,
    customerUserId,
  };
}

// ── Candidate repository ─────────────────────────────────────────────────────

/** Sentinel for "fresh at query time" — see `candidateRow`. */
export const FRESH = new Date(0);

export class FakeCandidateRepository implements CandidateRepository {
  rows: CandidateRow[] = [];

  async findCandidates(params: { now: Date }): Promise<readonly CandidateRow[]> {
    return this.rows.map((row) =>
      row.lastHeartbeatAt === FRESH ? { ...row, lastHeartbeatAt: params.now } : row,
    );
  }
}

// ── Matching repository ──────────────────────────────────────────────────────

interface StoredAttempt extends MatchingAttemptRecord {
  matchingRunId: string;
}

export class FakeMatchingRepository implements MatchingRepository {
  runs: MatchingRunRecord[] = [];
  attempts: StoredAttempt[] = [];
  /** Mirrors `ExpertProfile.availabilityStatus`, which the adapter also writes. */
  availability = new Map<string, AvailabilityStatus>();
  /** Set by `closeOffer(countAgainstReliability)` so tests can assert it. */
  reliabilityHits: string[] = [];

  seedAvailability(expertProfileId: string, status: AvailabilityStatus): void {
    this.availability.set(expertProfileId, status);
  }

  async persistRun(input: PersistRunInput): Promise<MatchingRunRecord> {
    const run: MatchingRunRecord = {
      id: nextId("run"),
      supportRequestId: input.supportRequestId,
      roundNumber: input.roundNumber,
      relaxationLevel: input.relaxationLevel,
      candidatePoolSize: input.candidatePoolSize,
      startedAt: input.now,
      completedAt: null,
    };
    this.runs.push(run);

    for (const entry of input.ranked) {
      this.attempts.push(
        blankAttempt({
          id: nextId("att"),
          matchingRunId: run.id,
          supportRequestId: input.supportRequestId,
          expertProfileId: entry.expertProfileId,
          origin: "ALGORITHMIC",
          rank: entry.rank,
          status: "RANKED",
          score: entry.score,
          now: input.now,
        }),
      );
    }
    for (const entry of input.excluded) {
      this.attempts.push(
        blankAttempt({
          id: nextId("att"),
          matchingRunId: run.id,
          supportRequestId: input.supportRequestId,
          expertProfileId: entry.expertProfileId,
          origin: "ALGORITHMIC",
          rank: null,
          status: "EXCLUDED",
          exclusionReasons: entry.reasons,
          now: input.now,
        }),
      );
    }

    return run;
  }

  async findRunById(id: string): Promise<MatchingRunRecord | null> {
    return this.runs.find((run) => run.id === id) ?? null;
  }

  async latestRunForRequest(supportRequestId: string): Promise<MatchingRunRecord | null> {
    const forRequest = this.runs.filter((run) => run.supportRequestId === supportRequestId);
    return forRequest[forRequest.length - 1] ?? null;
  }

  async nextRoundNumber(supportRequestId: string): Promise<number> {
    return this.runs.filter((run) => run.supportRequestId === supportRequestId).length + 1;
  }

  async listAttemptsForRequest(
    supportRequestId: string,
  ): Promise<readonly MatchingAttemptRecord[]> {
    return this.attempts.filter((attempt) => attempt.supportRequestId === supportRequestId);
  }

  async findAttemptById(id: string): Promise<MatchingAttemptRecord | null> {
    return this.attempts.find((attempt) => attempt.id === id) ?? null;
  }

  async findOpenOffer(supportRequestId: string): Promise<MatchingAttemptRecord | null> {
    return (
      this.attempts.find(
        (attempt) => attempt.supportRequestId === supportRequestId && attempt.status === "OFFERED",
      ) ?? null
    );
  }

  async findOpenOfferForExpert(expertProfileId: string): Promise<MatchingAttemptRecord | null> {
    return (
      this.attempts.find(
        (attempt) => attempt.expertProfileId === expertProfileId && attempt.status === "OFFERED",
      ) ?? null
    );
  }

  async findAttemptForExpertOnRequest(params: {
    expertProfileId: string;
    supportRequestId: string;
  }): Promise<MatchingAttemptRecord | null> {
    // Most recent last-wins, mirroring the adapter's `orderBy: createdAt desc`.
    // A request can put the same expert through several rounds, and the page
    // must show what happened most recently rather than the first attempt.
    const matches = [...this.attempts.values()].filter(
      (attempt) =>
        attempt.expertProfileId === params.expertProfileId &&
        attempt.supportRequestId === params.supportRequestId,
    );
    return matches.length > 0 ? (matches[matches.length - 1] ?? null) : null;
  }
  async listRespondedExpertIds(supportRequestId: string): Promise<readonly string[]> {
    return this.attempts
      .filter(
        (attempt) =>
          attempt.supportRequestId === supportRequestId &&
          (attempt.status === "DECLINED" || attempt.status === "TIMED_OUT"),
      )
      .map((attempt) => attempt.expertProfileId);
  }

  async nextRankedAttempt(params: {
    matchingRunId: string;
  }): Promise<MatchingAttemptRecord | null> {
    const responded = new Set(
      this.attempts
        .filter((attempt) => attempt.status === "DECLINED" || attempt.status === "TIMED_OUT")
        .map((attempt) => `${attempt.supportRequestId}:${attempt.expertProfileId}`),
    );
    return (
      this.attempts
        .filter(
          (attempt) =>
            attempt.matchingRunId === params.matchingRunId &&
            attempt.status === "RANKED" &&
            !responded.has(`${attempt.supportRequestId}:${attempt.expertProfileId}`),
        )
        .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))[0] ?? null
    );
  }

  async openOffer(params: {
    attemptId: string;
    expertProfileId: string;
    now: Date;
    offerExpiresAt: Date;
  }): Promise<MatchingAttemptRecord | null> {
    // The partial unique index, modelled. Without this the dispatcher's
    // next-candidate fallback is never exercised by a test.
    const held = this.attempts.find(
      (attempt) =>
        attempt.expertProfileId === params.expertProfileId && attempt.status === "OFFERED",
    );
    if (held) {
      throw new ConflictError("one_open_offer_per_expert", { attemptId: held.id });
    }

    const index = this.attempts.findIndex((attempt) => attempt.id === params.attemptId);
    const attempt = this.attempts[index];
    if (!attempt || (attempt.status !== "RANKED" && attempt.status !== "EXCLUDED")) return null;

    // The adapter's UPDATE is guarded on availability, so an expert who went
    // offline between ranking and dispatch fails here (requirement 14).
    const availability = this.availability.get(params.expertProfileId) ?? "AVAILABLE";
    const adminOriginated = attempt.origin !== "ALGORITHMIC";
    if (availability !== "AVAILABLE" && !(adminOriginated && availability === "OFFLINE")) {
      return null;
    }

    const updated: StoredAttempt = {
      ...attempt,
      status: "OFFERED",
      offeredAt: params.now,
      offerExpiresAt: params.offerExpiresAt,
    };
    this.attempts[index] = updated;
    this.availability.set(params.expertProfileId, "ON_OFFER");
    return updated;
  }

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
    const index = this.attempts.findIndex((attempt) => attempt.id === params.attemptId);
    const attempt = this.attempts[index];
    if (!attempt) return null;

    // A WITHDRAWN on an unofferable RANKED attempt is legitimate; everything
    // else must still be OFFERED. This is the guard that makes a decline
    // racing a timeout produce exactly one winner.
    const allowed =
      attempt.status === "OFFERED" ||
      (params.toStatus === "WITHDRAWN" && attempt.status === "RANKED");
    if (!allowed) return null;

    const updated: StoredAttempt = {
      ...attempt,
      status: params.toStatus,
      respondedAt: params.now,
      responseSeconds: attempt.offeredAt
        ? Math.round((params.now.getTime() - attempt.offeredAt.getTime()) / 1000)
        : null,
      declineReason: params.declineReason ?? null,
      declineNote: params.declineNote ?? null,
    };
    this.attempts[index] = updated;

    if (params.countAgainstReliability) this.reliabilityHits.push(attempt.id);
    if (params.releaseTo) this.availability.set(params.expertProfileId, params.releaseTo);
    return updated;
  }

  async supersedeRankedAttempts(params: { matchingRunId: string; now: Date }): Promise<number> {
    let count = 0;
    this.attempts = this.attempts.map((attempt) => {
      if (attempt.matchingRunId !== params.matchingRunId || attempt.status !== "RANKED") {
        return attempt;
      }
      count += 1;
      return { ...attempt, status: "SUPERSEDED" as const, respondedAt: params.now };
    });
    return count;
  }

  async createAdminAttempt(params: {
    matchingRunId: string;
    supportRequestId: string;
    expertProfileId: string;
    origin: Extract<AttemptOrigin, "ADMIN_ASSIGN" | "ADMIN_FORCE_ASSIGN">;
    adminReason: string;
    now: Date;
  }): Promise<MatchingAttemptRecord> {
    const attempt = blankAttempt({
      id: nextId("att"),
      matchingRunId: params.matchingRunId,
      supportRequestId: params.supportRequestId,
      expertProfileId: params.expertProfileId,
      origin: params.origin,
      rank: null,
      status: "RANKED",
      adminReason: params.adminReason,
      now: params.now,
    });
    this.attempts.push(attempt);
    return attempt;
  }

  async listOffersNeedingReconciliation(): Promise<
    readonly {
      attempt: MatchingAttemptRecord;
      expertStatus: ExpertStatus;
      accountStatus: "ACTIVE" | "SUSPENDED" | "DELETED";
      availabilityStatus: AvailabilityStatus;
      lastHeartbeatAt: Date | null;
    }[]
  > {
    return this.reconciliationQueue;
  }

  /** Set by a test to stage what the adapter's query would have returned. */
  reconciliationQueue: {
    attempt: MatchingAttemptRecord;
    expertStatus: ExpertStatus;
    accountStatus: "ACTIVE" | "SUSPENDED" | "DELETED";
    availabilityStatus: AvailabilityStatus;
    lastHeartbeatAt: Date | null;
  }[] = [];

  /** Staged by a test, like `reconciliationQueue`. */
  stalledQueue: string[] = [];

  async listStalledSearches(): Promise<readonly string[]> {
    return this.stalledQueue;
  }

  async completeRun(params: { matchingRunId: string; now: Date }): Promise<void> {
    this.runs = this.runs.map((run) =>
      run.id === params.matchingRunId ? { ...run, completedAt: params.now } : run,
    );
  }
}

function blankAttempt(params: {
  id: string;
  matchingRunId: string;
  supportRequestId: string;
  expertProfileId: string;
  origin: AttemptOrigin;
  rank: number | null;
  status: AttemptStatus;
  now: Date;
  score?: {
    skillScore: number;
    experienceScore: number;
    ratingScore: number;
    fairnessScore: number;
    reliabilityScore: number;
    finalScore: number;
    breakdown: Record<string, unknown>;
  };
  exclusionReasons?: readonly ExclusionReason[];
  adminReason?: string;
}): StoredAttempt {
  return {
    id: params.id,
    matchingRunId: params.matchingRunId,
    supportRequestId: params.supportRequestId,
    expertProfileId: params.expertProfileId,
    origin: params.origin,
    rank: params.rank,
    status: params.status,
    skillScore: params.score?.skillScore ?? 0,
    experienceScore: params.score?.experienceScore ?? 0,
    ratingScore: params.score?.ratingScore ?? 0,
    fairnessScore: params.score?.fairnessScore ?? 0,
    reliabilityScore: params.score?.reliabilityScore ?? 0,
    finalScore: params.score?.finalScore ?? 0,
    scoreBreakdown: params.score?.breakdown ?? {},
    exclusionReasons: params.exclusionReasons ?? [],
    offeredAt: null,
    offerExpiresAt: null,
    respondedAt: null,
    responseSeconds: null,
    declineReason: null,
    declineNote: null,
    adminReason: params.adminReason ?? null,
    createdAt: params.now,
  };
}
