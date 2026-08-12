import type {
  AttemptOrigin,
  AttemptStatus,
  AvailabilityStatus,
  DeclineReasonCode,
  ExclusionReason,
  ExpertStatus,
  ProficiencyLevel,
} from "@sfx/contracts";

/**
 * Persistence for matching runs, attempts, and the candidate query.
 *
 * The candidate query is the one place where "give me every plausible expert"
 * has to become SQL. Everything downstream of it — filtering, scoring, ranking
 * — is pure and lives in `matching/`. That split is deliberate: the database
 * narrows the set for performance, and the domain decides, so that a change to
 * the query plan can never quietly change who gets chosen.
 *
 * The candidate and score shapes live here rather than in `matching/` because
 * a port may not import a domain module — that would invert the dependency the
 * layering rests on. `matching/scoring.ts` imports them from here, which is the
 * allowed direction, so there is one declaration rather than two that drift.
 */

// ── The data matching runs on ────────────────────────────────────────────────

export interface RequiredSkill {
  readonly skillId: string;
  readonly slug: string;
  readonly categoryId: string;
  readonly isPrimary: boolean;
}

export interface CandidateSkill {
  readonly skillId: string;
  readonly slug: string;
  readonly categoryId: string;
  readonly proficiencyLevel: ProficiencyLevel;
  readonly yearsExperience: number;
  readonly verified: boolean;
}

export interface Candidate {
  readonly expertProfileId: string;
  readonly userId: string;
  readonly skills: readonly CandidateSkill[];
  /** Overall Salesforce experience from the profile — not per-skill. */
  readonly yearsExperience: number;
  readonly ratingSum: number;
  readonly ratingCount: number;
  readonly offersReceived: number;
  readonly offersAccepted: number;
  readonly avgResponseSeconds: number | null;
  readonly sessionsToday: number;
  /** Minutes since this expert was last offered work. Null means never. */
  readonly idleMinutes: number | null;
  readonly languages: readonly string[];
}

export interface SkillScoreDetail {
  readonly slug: string;
  readonly isPrimary: boolean;
  readonly proficiencyLevel: ProficiencyLevel | null;
  readonly verified: boolean;
  readonly value: number;
  /** True when a sibling skill in the same category stood in (level 3 only). */
  readonly viaCategory: boolean;
}

export interface ScoreComponents {
  readonly skillScore: number;
  readonly experienceScore: number;
  readonly ratingScore: number;
  readonly fairnessScore: number;
  readonly reliabilityScore: number;
  readonly finalScore: number;
  /** Everything needed to reconstruct the number without the candidate. */
  readonly breakdown: {
    readonly weightedAverage: number;
    readonly minPrimaryValue: number;
    /**
     * The **ordinal proficiency level** of the candidate's weakest primary
     * skill (requirement 2). Ranking sorts on this before it looks at the
     * weighted score, which is what makes primary competence *dominate* rather
     * than merely contribute — no combination of rating, tenure, fairness or
     * reliability can promote a candidate out of their band.
     *
     * The declared level, not the verified-adjusted value: verification helps
     * within a band and never moves you between them (requirement 5).
     */
    readonly primaryBand: number;
    readonly perSkill: readonly SkillScoreDetail[];
    readonly shrunkRating: number;
    readonly acceptanceRate: number | null;
    readonly idleMinutes: number | null;
    readonly sessionsToday: number;
  };
}

// ── Candidate query ──────────────────────────────────────────────────────────

export interface CandidateRow {
  readonly candidate: Candidate;
  readonly expertStatus: ExpertStatus;
  readonly accountStatus: "ACTIVE" | "SUSPENDED" | "DELETED";
  readonly availabilityStatus: AvailabilityStatus;
  readonly lastHeartbeatAt: Date | null;
  readonly customerUserId: string;
}

export interface CandidateRepository {
  /**
   * Every expert worth considering for this request.
   *
   * Deliberately broad. The query filters on `status = APPROVED` and nothing
   * else about eligibility — an expert who is offline or stale still comes back
   * and is excluded *by the domain*, with a reason, so the audit trail can say
   * "we looked at them and here is why not" rather than silently omitting them.
   *
   * `excludeExpertProfileIds` carries the experts who already declined or timed
   * out; those are the one case where re-fetching buys nothing, because the
   * answer is recorded and permanent for this request.
   *
   * **Bounded, and the bound rotates.** `limit` is a real cut, so on a bench
   * larger than it some experts are not returned at all. Which ones is not
   * arbitrary and not fixed: implementations must order by least-recently-
   * assigned and then least-recently-*considered*, and must record that the
   * candidates they return have now been considered. Without that second rule
   * the cut is stable and the same experts are returned forever — every expert
   * who has never been assigned ties on the first rule.
   *
   * That ordering decides **membership only**. It carries no opinion about
   * quality, contributes nothing to any score, and the domain re-ranks whatever
   * it is given; a caller must not read the returned order as a ranking.
   */
  findCandidates(params: {
    readonly supportRequestId: string;
    readonly requiredSkillIds: readonly string[];
    readonly now: Date;
    readonly limit: number;
  }): Promise<readonly CandidateRow[]>;
}

// ── Runs and attempts ────────────────────────────────────────────────────────

export interface MatchingRunRecord {
  readonly id: string;
  readonly supportRequestId: string;
  readonly roundNumber: number;
  readonly relaxationLevel: number;
  readonly candidatePoolSize: number;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
}

export interface MatchingAttemptRecord {
  readonly id: string;
  readonly matchingRunId: string;
  readonly supportRequestId: string;
  readonly expertProfileId: string;
  readonly origin: AttemptOrigin;
  readonly rank: number | null;
  readonly status: AttemptStatus;
  readonly skillScore: number;
  readonly experienceScore: number;
  readonly ratingScore: number;
  readonly fairnessScore: number;
  readonly reliabilityScore: number;
  readonly finalScore: number;
  readonly scoreBreakdown: Record<string, unknown>;
  readonly exclusionReasons: readonly string[];
  readonly offeredAt: Date | null;
  readonly offerExpiresAt: Date | null;
  readonly respondedAt: Date | null;
  readonly responseSeconds: number | null;
  readonly declineReason: DeclineReasonCode | null;
  readonly declineNote: string | null;
  readonly adminReason: string | null;
  readonly createdAt: Date;
}

export interface PersistRunInput {
  readonly supportRequestId: string;
  readonly roundNumber: number;
  readonly relaxationLevel: number;
  readonly weightsSnapshot: Record<string, unknown>;
  readonly thresholdsSnapshot: Record<string, unknown>;
  readonly candidatePoolSize: number;
  readonly filtersApplied: Record<string, unknown>;
  readonly now: Date;
  readonly ranked: readonly {
    readonly expertProfileId: string;
    readonly rank: number;
    readonly score: ScoreComponents;
  }[];
  readonly excluded: readonly {
    readonly expertProfileId: string;
    readonly reasons: readonly ExclusionReason[];
  }[];
}

export interface MatchingRepository {
  /** Creates the run and all of its attempt rows — ranked and excluded — atomically. */
  persistRun(input: PersistRunInput): Promise<MatchingRunRecord>;

  findRunById(id: string): Promise<MatchingRunRecord | null>;
  latestRunForRequest(supportRequestId: string): Promise<MatchingRunRecord | null>;
  nextRoundNumber(supportRequestId: string): Promise<number>;

  listAttemptsForRequest(supportRequestId: string): Promise<readonly MatchingAttemptRecord[]>;
  findAttemptById(id: string): Promise<MatchingAttemptRecord | null>;

  /** The attempt currently OFFERED for a request, if any. At most one. */
  findOpenOffer(supportRequestId: string): Promise<MatchingAttemptRecord | null>;
  /** The open offer held by an expert, across all requests. At most one. */
  findOpenOfferForExpert(expertProfileId: string): Promise<MatchingAttemptRecord | null>;

  /**
   * The interest-pool equivalent: an attempt a customer has picked and that is
   * waiting on this expert's confirmation.
   *
   * Deliberately separate from `findOpenOfferForExpert` rather than folded into
   * it, because that one also answers "does this expert already hold work?" for
   * the exclusive dispatcher's guard. Widening it to CONFIRMING would silently
   * change who the ranker considers eligible, which is not a decision that
   * belongs to a UI lookup.
   */
  findPendingConfirmationForExpert(expertProfileId: string): Promise<MatchingAttemptRecord | null>;

  /**
   * This expert's attempt on this request, whatever became of it.
   *
   * Doubles as the authorization rule for the expert-facing request page: no
   * attempt means they were never considered, which means they may not read it.
   * Expressing it as "find the row that grants access" rather than a separate
   * permission check makes the two impossible to get out of step.
   *
   * Returns the most recent when a request has been through several rounds and
   * the same expert appears more than once.
   */
  findAttemptForExpertOnRequest(params: {
    readonly expertProfileId: string;
    readonly supportRequestId: string;
  }): Promise<MatchingAttemptRecord | null>;

  /** Experts who already declined or timed out here — permanently out. */
  listRespondedExpertIds(supportRequestId: string): Promise<readonly string[]>;

  /**
   * The next RANKED attempt to offer, best rank first, skipping any expert who
   * has since responded.
   */
  nextRankedAttempt(params: {
    readonly matchingRunId: string;
  }): Promise<MatchingAttemptRecord | null>;

  /**
   * Moves a RANKED attempt to OFFERED and locks the expert, in one transaction.
   *
   * Throws `ConflictError` when the `one_open_offer_per_expert` partial unique
   * index rejects the write — that is the concurrency guard doing its job, and
   * the caller responds by trying the next candidate rather than by failing the
   * request.
   *
   * `offerExpiresAt` is passed in and stored so the deadline is a fact about
   * the offer rather than a property of a scheduled job (requirement 8).
   */
  openOffer(params: {
    readonly attemptId: string;
    readonly expertProfileId: string;
    readonly now: Date;
    readonly offerExpiresAt: Date;
  }): Promise<MatchingAttemptRecord | null>;

  /**
   * Records the expert's answer and releases their availability lock.
   *
   * Guarded on the attempt still being OFFERED, so a decline arriving just
   * after a timeout — or a second click — is a clean no-op rather than a
   * double-write. Returns null when it lost.
   */
  closeOffer(params: {
    readonly attemptId: string;
    readonly expertProfileId: string;
    readonly toStatus: Extract<
      AttemptStatus,
      "ACCEPTED" | "DECLINED" | "TIMED_OUT" | "SUPERSEDED" | "WITHDRAWN"
    >;
    readonly now: Date;
    readonly declineReason?: DeclineReasonCode | null;
    readonly declineNote?: string | null;
    /**
     * Whether this outcome counts against the expert's acceptance rate.
     * False for sweeps and admin supersessions — a presence problem or an
     * operator's decision must not damage someone's reliability score.
     */
    readonly countAgainstReliability: boolean;
    /** Availability to return the expert to. Null leaves it untouched. */
    readonly releaseTo: AvailabilityStatus | null;
  }): Promise<MatchingAttemptRecord | null>;

  /** Marks every still-RANKED attempt in a run as SUPERSEDED. */
  supersedeRankedAttempts(params: {
    readonly matchingRunId: string;
    readonly now: Date;
  }): Promise<number>;

  /** Creates an admin-originated attempt outside the ranking. */
  createAdminAttempt(params: {
    readonly matchingRunId: string;
    readonly supportRequestId: string;
    readonly expertProfileId: string;
    readonly origin: Extract<AttemptOrigin, "ADMIN_ASSIGN" | "ADMIN_FORCE_ASSIGN">;
    readonly adminReason: string;
    readonly now: Date;
  }): Promise<MatchingAttemptRecord>;

  /**
   * Open offers held by an expert who should no longer be holding one
   * (requirement 14).
   *
   * Suspension, an account going inactive, or presence going stale while an
   * offer is open. Phase 4's presence sweep deliberately left `ON_OFFER` alone
   * because it had nothing to re-dispatch with; this is the method that closes
   * that gap, and the reconciler is what calls it.
   */
  listOffersNeedingReconciliation(params: {
    readonly staleBefore: Date;
    readonly limit: number;
  }): Promise<
    readonly {
      readonly attempt: MatchingAttemptRecord;
      readonly expertStatus: ExpertStatus;
      readonly accountStatus: "ACTIVE" | "SUSPENDED" | "DELETED";
      readonly availabilityStatus: AvailabilityStatus;
      readonly lastHeartbeatAt: Date | null;
    }[]
  >;

  /**
   * Requests that are being matched but have nothing in flight.
   *
   * A `SEARCHING` request with no open offer and no pending dispatch has
   * stalled — almost certainly a lost enqueue. The 15-minute deadline would
   * eventually rescue it, but 15 minutes of silence is a bad outcome for
   * something that could have been offered in seconds, so a janitor picks it up.
   *
   * `OFFERED` rows are excluded: those have their own timeout.
   */
  listStalledSearches(params: {
    readonly stalledBefore: Date;
    readonly limit: number;
  }): Promise<readonly string[]>;

  // ── Interest pool ─────────────────────────────────────────────────────────

  /**
   * Requests broadcast to this expert that they have not answered yet.
   *
   * Capped by rank: a broadcast reaches the top N, so an attempt ranked below
   * that is not an opportunity even though the row exists. Filtering here rather
   * than in the caller keeps "who was actually asked" a single definition.
   */
  listInterestOpportunities(params: {
    readonly expertProfileId: string;
    readonly maxRank: number;
    readonly now: Date;
  }): Promise<readonly MatchingAttemptRecord[]>;

  /** RANKED → INTERESTED | NOT_INTERESTED. Guarded, so a second answer is a no-op. */
  recordInterest(params: {
    readonly attemptId: string;
    readonly expertProfileId: string;
    readonly interested: boolean;
    readonly now: Date;
  }): Promise<{ readonly changed: boolean }>;

  /** Everyone who raised a hand, in rank order. */
  listInterested(supportRequestId: string): Promise<readonly MatchingAttemptRecord[]>;

  /** Marks the chosen few SHORTLISTED and supersedes the rest of the round. */
  markShortlisted(params: {
    readonly supportRequestId: string;
    readonly attemptIds: readonly string[];
    readonly now: Date;
  }): Promise<number>;

  listShortlisted(supportRequestId: string): Promise<readonly MatchingAttemptRecord[]>;

  /**
   * SHORTLISTED → CONFIRMING, with a stored deadline.
   *
   * The deadline is persisted rather than held by a timer, for the same reason
   * the offer window is: a worker restart must not hand anyone a fresh two
   * minutes. Guarded on the current status so two customers cannot both select.
   */
  startConfirmation(params: {
    readonly attemptId: string;
    readonly expertProfileId: string;
    readonly expiresAt: Date;
    readonly now: Date;
  }): Promise<MatchingAttemptRecord | null>;

  /**
   * Settles a confirmation window: CONFIRMING → ACCEPTED | TIMED_OUT.
   *
   * A separate method from `closeOffer` rather than a looser guard on it,
   * because the two protect different things. `closeOffer` is guarded on
   * OFFERED and defends the exclusive loop; widening it would let a confirmation
   * be settled by the offer path and vice versa. Returns null when it lost the
   * race — a confirmation arriving just after the timer, or the other way round.
   */
  settleConfirmation(params: {
    readonly attemptId: string;
    readonly expertProfileId: string;
    readonly toStatus: "ACCEPTED" | "TIMED_OUT" | "DECLINED";
    readonly now: Date;
    readonly releaseTo: AvailabilityStatus | null;
    /** Only meaningful with DECLINED; a timeout has no reason to record. */
    readonly declineReason?: DeclineReasonCode | null;
  }): Promise<MatchingAttemptRecord | null>;

  /** Confirmations whose window has closed but which nothing has settled yet. */
  listLapsedConfirmations(params: {
    readonly now: Date;
    readonly limit: number;
  }): Promise<readonly MatchingAttemptRecord[]>;

  completeRun(params: { readonly matchingRunId: string; readonly now: Date }): Promise<void>;
}
