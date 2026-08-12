import type { AvailabilityStatus } from "@sfx/contracts";
import { authorize, type Actor } from "../authorization/index.js";
import type { Clock } from "../ports/clock.js";
import type { Logger } from "../ports/logger.js";
import type { AttemptOrigin, DeclineReasonCode } from "@sfx/contracts";
import type {
  CandidateRepository,
  MatchingAttemptRecord,
  MatchingRepository,
  MatchingRunRecord,
  RequiredSkill,
} from "../ports/matching-repositories.js";
import type {
  JobScheduler,
  SupportRequestRecord,
  SupportRequestRepository,
} from "../ports/request-repositories.js";
import type { AuditLogRepository } from "../ports/repositories.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import { assertTransition } from "../support-requests/state-machine.js";
import { TIMING_POINTS, type DispatchNotifier } from "./dispatch-events.js";
import type { ExclusionReason } from "./filters.js";
import type { InterestDispatch } from "./interest-dispatch.js";
import { rankCandidates, type RankingResult } from "./rank.js";
import {
  DEFAULT_RELAXATION_SCHEDULE_SECONDS,
  engagesAtSeconds,
  MAX_RELAXATION_LEVEL,
  ruleForLevel,
  scheduledLevel,
} from "./relaxation.js";
import { DEFAULT_SCORING_THRESHOLDS, DEFAULT_WEIGHTS, type ScoringWeights } from "./scoring.js";

/**
 * Stages 4 and 5 — dispatch, and controlled relaxation (§15).
 *
 * The pure half of matching lives in `rank.ts` and answers "who, in what
 * order". This half answers "and then what", which needs a clock, a database
 * and a job queue, and is therefore the part that has to survive crashes,
 * duplicate deliveries and two workers racing.
 *
 * Three timing facts hold the loop together, and each is stored rather than
 * inferred:
 *
 *   - `SupportRequest.matchDeadlineAt` — 15 minutes from submission, set once
 *     and **never** recomputed (requirement 7). Not by an offer expiring, not
 *     by relaxation stepping up, not by a re-dispatch.
 *   - `MatchingAttempt.offerExpiresAt` — 60 seconds from the offer, stored so a
 *     worker restart or a duplicate job cannot buy a fresh window
 *     (requirement 8).
 *   - `MatchingAttempt.status` — the single source of truth for whether an
 *     offer is still live. Every write is guarded on it, so a decline racing a
 *     timeout produces one winner and one no-op.
 */

export interface MatchingThresholds {
  readonly offerWindowSeconds: number;
  readonly candidatePoolSize: number;
  readonly fairnessHorizonMinutes: number;
  readonly ratingPriorCount: number;
  readonly ratingPriorMean: number;
  readonly minRating: number;
  readonly minRatedSessions: number;
  readonly heartbeatStaleAfterSeconds: number;
  /** How long an OFFERED expert may be silent before the offer is reconciled away. */
  readonly offerPresenceGraceSeconds: number;
  /**
   * Seconds from submission at which each relaxation level becomes available.
   *
   * Configuration, snapshotted onto every run. Tuning it changes how *soon* the
   * search widens and never how *far* — the primary floor is enforced
   * independently by `floorForLevel`.
   */
  readonly relaxationScheduleSeconds: readonly number[];
}

export const DEFAULT_MATCHING_THRESHOLDS: MatchingThresholds = {
  offerWindowSeconds: 60,
  candidatePoolSize: 10,
  ...DEFAULT_SCORING_THRESHOLDS,
  minRating: 3.5,
  minRatedSessions: 3,
  heartbeatStaleAfterSeconds: 180,
  offerPresenceGraceSeconds: 180,
  relaxationScheduleSeconds: DEFAULT_RELAXATION_SCHEDULE_SECONDS,
};

export interface MatchingQueues {
  readonly dispatchNextOffer: string;
  readonly offerTimeout: string;
  readonly matchingDeadline: string;
}

export interface MatchingServiceDeps {
  readonly requests: SupportRequestRepository;
  readonly matching: MatchingRepository;
  readonly candidates: CandidateRepository;
  readonly auditLog: AuditLogRepository;
  readonly scheduler: JobScheduler;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly queues: MatchingQueues;
  readonly weights?: ScoringWeights;
  readonly thresholds?: MatchingThresholds;
  /**
   * Realtime delivery and timing. Optional: without it every offer is still
   * created, still expires on time, and is still visible on the dashboard —
   * only the immediacy is lost (requirement 10).
   */
  readonly notifier?: DispatchNotifier;
  /**
   * The interest-pool loop. Optional and off by default: with no `interest`
   * dependency, or with mode `exclusive`, every path below behaves exactly as it
   * did before, which is what keeps the existing suites meaningful.
   */
  readonly interest?: InterestDispatch;
  readonly dispatchMode?: "exclusive" | "interest_pool";
}

export interface DispatchOutcome {
  readonly action:
    | "OFFERED"
    | "RELAXED"
    | "NO_EXPERT_FOUND"
    | "DEADLINE_PASSED"
    | "ALREADY_OFFERED"
    | "NOT_SEARCHING";
  readonly attempt?: MatchingAttemptRecord;
  readonly relaxationLevel?: number;
  readonly reason?: string;
}

export class MatchingService {
  private readonly weights: ScoringWeights;
  private readonly thresholds: MatchingThresholds;

  constructor(private readonly deps: MatchingServiceDeps) {
    this.weights = deps.weights ?? DEFAULT_WEIGHTS;
    this.thresholds = deps.thresholds ?? DEFAULT_MATCHING_THRESHOLDS;
  }

  /**
   * Notification is a side effect, never a step.
   *
   * Called after the durable write has already committed, and it cannot throw —
   * `DispatchNotifier` swallows its own failures. Requirement 10 is satisfied by
   * the ordering plus that guarantee: there is no point in the flow where a
   * notification problem can prevent, undo, or delay a state change.
   */
  private get notify(): DispatchNotifier | undefined {
    return this.deps.notifier;
  }

  // ── Entry ──────────────────────────────────────────────────────────────────

  /**
   * Called when a request reaches SEARCHING.
   *
   * Schedules the 15-minute deadline once, here, from a value already stored on
   * the request. The job is a backstop for a search that stalls; the *authority*
   * is `matchDeadlineAt`, which every dispatch re-reads.
   */
  async beginSearch(supportRequestId: string): Promise<DispatchOutcome> {
    const request = await this.requireRequest(supportRequestId);

    await this.deps.scheduler.enqueue({
      queue: this.deps.queues.matchingDeadline,
      payload: { supportRequestId },
      runAfterSeconds: Math.max(
        0,
        Math.ceil((request.matchDeadlineAt.getTime() - this.deps.clock.now().getTime()) / 1000),
      ),
      // One deadline per request, ever. A re-entry into SEARCHING must not
      // schedule a second one.
      singletonKey: `deadline:${supportRequestId}`,
    });

    // The customer's screen should say "finding the right expert" the moment we
    // start, not only once an offer happens to land (requirement 5). A search
    // that spends its first 90 seconds waiting for the relaxation schedule would
    // otherwise look identical to one that had stalled.
    await this.notify?.requestStateChanged(supportRequestId, request.customerId);

    return this.dispatchNextOffer(supportRequestId);
  }

  // ── Stage 4: dispatch ──────────────────────────────────────────────────────

  /**
   * Offer the request to the next-best candidate, relaxing if the pool is dry.
   *
   * Idempotent by construction. Every early return is a state the caller might
   * legitimately be in after a retry: already offered, no longer searching,
   * deadline passed.
   */
  async dispatchNextOffer(supportRequestId: string): Promise<DispatchOutcome> {
    // The single branch point between the two dispatch models. Every caller —
    // beginSearch, the relaxation job, the stalled-search sweeper — arrives
    // here, so routing once means none of them needs to know which mode is on.
    if (this.interestEnabled) return this.broadcastInterest(supportRequestId);

    const now = this.deps.clock.now();
    const request = await this.requireRequest(supportRequestId);

    if (request.state !== "SEARCHING") {
      // OFFERED means someone else's dispatch won the race, or the customer's
      // request already moved on. Either way there is nothing to do.
      return {
        action: request.state === "OFFERED" ? "ALREADY_OFFERED" : "NOT_SEARCHING",
        reason: `request is ${request.state}`,
      };
    }

    // Requirement 7. Checked before every offer, from the stored value.
    if (now >= request.matchDeadlineAt) {
      await this.giveUp(request, "The 15-minute matching window elapsed.");
      return { action: "DEADLINE_PASSED" };
    }

    let run = await this.deps.matching.latestRunForRequest(supportRequestId);
    if (!run) run = await this.createRun(request, 0, now);

    // Walk candidates at this level, then step up a level, until something
    // sticks or we run out of both.
    for (;;) {
      const offered = await this.tryOfferFromRun(request, run, now);
      if (offered) {
        return { action: "OFFERED", attempt: offered, relaxationLevel: run.relaxationLevel };
      }

      const nextLevel = run.relaxationLevel + 1;
      if (nextLevel > MAX_RELAXATION_LEVEL) {
        await this.giveUp(
          request,
          "No expert met the minimum competence for this problem, even at maximum relaxation.",
        );
        return { action: "NO_EXPERT_FOUND" };
      }

      // The schedule caps how fast we relax. A search that burns through three
      // candidates in ten seconds should not arrive at level 3 immediately —
      // the point of relaxing is to trade quality for time, and no time has
      // passed yet.
      const elapsedSeconds = (now.getTime() - request.createdAt.getTime()) / 1000;
      if (nextLevel > scheduledLevel(elapsedSeconds, this.thresholds.relaxationScheduleSeconds)) {
        this.deps.logger.info("matching pool exhausted; waiting for the relaxation schedule", {
          supportRequestId,
          currentLevel: run.relaxationLevel,
          elapsedSeconds: Math.round(elapsedSeconds),
          nextLevelAtSeconds: engagesAtSeconds(
            nextLevel,
            this.thresholds.relaxationScheduleSeconds,
          ),
        });
        // Come back when the next level is due. Not a failure — experts also
        // come online during this window and get picked up by the re-rank.
        await this.deps.scheduler.enqueue({
          queue: this.deps.queues.dispatchNextOffer,
          payload: { supportRequestId },
          runAfterSeconds: this.secondsUntilNextLevel(nextLevel, request.createdAt, now),
          singletonKey: `dispatch:${supportRequestId}:level:${nextLevel}`,
        });
        return { action: "RELAXED", relaxationLevel: run.relaxationLevel };
      }

      await this.deps.matching.supersedeRankedAttempts({ matchingRunId: run.id, now });
      await this.deps.matching.completeRun({ matchingRunId: run.id, now });
      run = await this.createRun(request, nextLevel, now);
    }
  }

  /**
   * Try each ranked candidate in this run until one accepts the offer lock.
   *
   * The loop is requirement 14's answer for the pre-offer case: an expert who
   * went offline, took another offer, or was suspended between ranking and
   * dispatch simply fails the guarded write, gets marked WITHDRAWN, and we move
   * on. The request is never stranded on a stale ranking.
   */
  private async tryOfferFromRun(
    request: SupportRequestRecord,
    run: MatchingRunRecord,
    now: Date,
  ): Promise<MatchingAttemptRecord | null> {
    for (;;) {
      const attempt = await this.deps.matching.nextRankedAttempt({ matchingRunId: run.id });
      if (!attempt) return null;

      const offerExpiresAt = new Date(now.getTime() + this.thresholds.offerWindowSeconds * 1000);
      // Never let an offer outlive the matching deadline — a 60-second window
      // starting at t+14m50s would keep a customer waiting past the promise.
      const expiresAt =
        offerExpiresAt > request.matchDeadlineAt ? request.matchDeadlineAt : offerExpiresAt;

      let opened: MatchingAttemptRecord | null = null;
      try {
        opened = await this.deps.matching.openOffer({
          attemptId: attempt.id,
          expertProfileId: attempt.expertProfileId,
          now,
          offerExpiresAt: expiresAt,
        });
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error;
        // `one_open_offer_per_expert` rejected the insert: this expert was
        // offered a different request microseconds ago. Not an error — the
        // index doing exactly what it exists for.
        this.deps.logger.info("expert took another offer first", {
          supportRequestId: request.id,
          expertProfileId: attempt.expertProfileId,
        });
      }

      if (!opened) {
        await this.deps.matching.closeOffer({
          attemptId: attempt.id,
          expertProfileId: attempt.expertProfileId,
          toStatus: "WITHDRAWN",
          now,
          // Not their fault and not their choice — must not touch their
          // acceptance rate.
          countAgainstReliability: false,
          releaseTo: null,
        });
        continue;
      }

      await this.transition(request, "OFFERED", {
        actorType: "SYSTEM",
        reason: `Offered to expert ${attempt.expertProfileId} (rank ${String(attempt.rank)}).`,
        metadata: { attemptId: opened.id, relaxationLevel: run.relaxationLevel },
      });

      await this.scheduleOfferTimeout(opened, now);

      this.notify?.timing(TIMING_POINTS.OFFER_PERSISTED, {
        supportRequestId: request.id,
        attemptId: opened.id,
        expertProfileId: opened.expertProfileId,
        rank: opened.rank,
        relaxationLevel: run.relaxationLevel,
        sinceSubmittedMs: now.getTime() - request.createdAt.getTime(),
      });
      await this.notify?.offerOpened({
        expertProfileId: opened.expertProfileId,
        supportRequestId: request.id,
        customerId: request.customerId,
        offeredAt: opened.offeredAt ?? now,
      });

      return opened;
    }
  }

  /**
   * Requirement 8 — the window is a stored deadline, and this job only reads it.
   *
   * `singletonKey` is the attempt id, so a re-enqueue collapses instead of
   * stacking. The handler re-derives nothing.
   */
  private async scheduleOfferTimeout(attempt: MatchingAttemptRecord, now: Date): Promise<void> {
    const expiresAt = attempt.offerExpiresAt ?? now;
    await this.deps.scheduler.enqueue({
      queue: this.deps.queues.offerTimeout,
      payload: { supportRequestId: attempt.supportRequestId, matchingAttemptId: attempt.id },
      runAfterSeconds: Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / 1000)),
      singletonKey: `offer-timeout:${attempt.id}`,
    });
  }

  private async createRun(
    request: SupportRequestRecord,
    relaxationLevel: number,
    now: Date,
  ): Promise<MatchingRunRecord> {
    const ranking = await this.rankFor(request, relaxationLevel, now);
    const roundNumber = await this.deps.matching.nextRoundNumber(request.id);
    const rule = ruleForLevel(relaxationLevel);

    const run = await this.deps.matching.persistRun({
      supportRequestId: request.id,
      roundNumber,
      relaxationLevel,
      // §C7 — snapshotted onto the run, so a later weight change can never
      // retroactively rewrite the reasoning behind this decision.
      weightsSnapshot: { ...this.weights },
      thresholdsSnapshot: { ...this.thresholds },
      candidatePoolSize: ranking.ranked.length,
      filtersApplied: {
        primaryFloor: rule.primaryFloor,
        secondaryCoverage: rule.secondaryCoverage,
        enforceRatingFloor: rule.enforceRatingFloor,
        enforceLanguage: rule.enforceLanguage,
        widenSecondaryToCategory: rule.widenSecondaryToCategory,
        describes: rule.describes,
      },
      now,
      ranked: ranking.ranked.map((entry) => ({
        expertProfileId: entry.expertProfileId,
        rank: entry.rank,
        score: entry.score,
      })),
      // Requirement 4: excluded candidates are recorded, with every reason.
      excluded: ranking.excluded.map((entry) => ({
        expertProfileId: entry.expertProfileId,
        reasons: entry.reasons,
      })),
    });

    this.notify?.timing(TIMING_POINTS.MATCHING_RUN_STARTED, {
      supportRequestId: request.id,
      runId: run.id,
      relaxationLevel,
      ranked: ranking.ranked.length,
      excluded: ranking.excluded.length,
      sinceSubmittedMs: now.getTime() - request.createdAt.getTime(),
    });

    this.deps.logger.info("matching run created", {
      supportRequestId: request.id,
      runId: run.id,
      relaxationLevel,
      ranked: ranking.ranked.length,
      excluded: ranking.excluded.length,
      primaryFloor: rule.primaryFloor,
    });

    return run;
  }

  /** Pure ranking, fed from the database. Separated so tests can call it alone. */
  async rankFor(
    request: SupportRequestRecord,
    relaxationLevel: number,
    now: Date,
  ): Promise<RankingResult> {
    const required: RequiredSkill[] = request.skills.map((skill) => ({
      skillId: skill.skillId,
      slug: skill.slug,
      // The candidate query supplies category ids; the request skill record
      // does not carry one, so category substitution keys off the candidate's
      // own skills. Filled from the taxonomy by the adapter.
      categoryId: "",
      isPrimary: skill.isPrimary,
    }));

    const responded = new Set(await this.deps.matching.listRespondedExpertIds(request.id));

    const rows = await this.deps.candidates.findCandidates({
      supportRequestId: request.id,
      requiredSkillIds: required.map((skill) => skill.skillId),
      now,
      // Fetch well beyond the pool size: the domain, not the query, decides who
      // is excluded, and a truncated fetch would hide exclusions from the audit.
      limit: Math.max(this.thresholds.candidatePoolSize * 5, 50),
    });

    return rankCandidates({
      required: required.map((skill) => ({
        ...skill,
        categoryId: categoryOf(skill.skillId, rows) ?? "",
      })),
      candidates: rows.map((row) => ({
        candidate: row.candidate,
        eligibility: {
          expertStatus: row.expertStatus,
          accountStatus: row.accountStatus,
          availabilityStatus: row.availabilityStatus,
          lastHeartbeatAt: row.lastHeartbeatAt,
          alreadyResponded: responded.has(row.candidate.expertProfileId),
          isRequestingCustomer: row.customerUserId === row.candidate.userId,
        },
      })),
      relaxationLevel,
      weights: this.weights,
      thresholds: this.thresholds,
      customerLanguages: [],
      now,
      poolSize: this.thresholds.candidatePoolSize,
      tieBreakSeed: request.id,
    });
  }

  // ── Expert response ────────────────────────────────────────────────────────

  /**
   * Accept.
   *
   * Guarded on the attempt still being OFFERED *and* on the request still being
   * OFFERED. A second click, or an accept arriving a moment after the timeout
   * fired, loses the guard and returns the current state rather than throwing —
   * an expert who accepted successfully should never see an error because they
   * double-clicked.
   */
  /**
   * What an expert is allowed to read about one request.
   *
   * Used by the page a notification links to. The authorization is the lookup
   * itself: an expert without an attempt on this request gets `NotFoundError`,
   * identical to a request that does not exist. That is deliberate — a distinct
   * "forbidden" would confirm the id is real, turning the endpoint into an
   * oracle for enumerating other people's requests.
   *
   * Returns the attempt alongside the request so the caller can say what became
   * of it: still open, taken by them, declined, or gone to someone else.
   */
  async requestDetailForExpert(
    actor: Actor,
    supportRequestId: string,
  ): Promise<{ attempt: MatchingAttemptRecord; request: SupportRequestRecord }> {
    authorize(actor, "offer:respond");
    const expertProfileId = actor.expert?.profileId;
    if (!expertProfileId) throw new NotFoundError("SupportRequest", supportRequestId);

    const attempt = await this.deps.matching.findAttemptForExpertOnRequest({
      expertProfileId,
      supportRequestId,
    });
    if (!attempt) throw new NotFoundError("SupportRequest", supportRequestId);

    const request = await this.requireRequest(supportRequestId);
    return { attempt, request };
  }

  /**
   * Nobody to ask at this level: relax, wait, or give up.
   *
   * Shared by both dispatch modes on purpose — "the pool is dry" means the same
   * thing whether everyone declined an exclusive offer or nobody raised a hand,
   * and the relaxation ladder is the one place that decides what to do about it.
   */
  private async handleEmptyPool(
    request: SupportRequestRecord,
    level: number,
    now: Date,
  ): Promise<DispatchOutcome> {
    const nextLevel = level + 1;
    if (nextLevel > MAX_RELAXATION_LEVEL) {
      await this.giveUp(
        request,
        "No expert met the minimum competence for this problem, even at maximum relaxation.",
      );
      return { action: "NO_EXPERT_FOUND", reason: "pool exhausted at maximum relaxation" };
    }

    const elapsedSeconds = (now.getTime() - request.createdAt.getTime()) / 1000;
    if (nextLevel > scheduledLevel(elapsedSeconds, this.thresholds.relaxationScheduleSeconds)) {
      // Not yet due. Experts also come online during this window, so the
      // re-rank when it fires is not merely a repeat.
      await this.deps.scheduler.enqueue({
        queue: this.deps.queues.dispatchNextOffer,
        payload: { supportRequestId: request.id },
        runAfterSeconds: this.secondsUntilNextLevel(nextLevel, request.createdAt, now),
        singletonKey: `dispatch:${request.id}:level:${String(nextLevel)}`,
      });
      return { action: "RELAXED", relaxationLevel: level };
    }

    await this.deps.scheduler.enqueue({
      queue: this.deps.queues.dispatchNextOffer,
      payload: { supportRequestId: request.id },
      runAfterSeconds: 0,
      singletonKey: `dispatch:${request.id}:level:${String(nextLevel)}`,
    });
    return { action: "RELAXED", relaxationLevel: nextLevel };
  }

  // ── Interest-pool dispatch (DISPATCH_MODE=interest_pool) ──────────────────
  //
  // These sit beside the exclusive loop rather than replacing it. `InterestDispatch`
  // owns the attempt mechanics; the request's own state transitions stay here,
  // because this is where `transition()` and the request repository already live
  // and duplicating either would be how the two drift apart.

  private get interestEnabled(): boolean {
    return this.deps.dispatchMode === "interest_pool" && this.deps.interest !== undefined;
  }

  /**
   * Broadcasts a ranked round to the top N instead of offering it to one expert.
   *
   * Reuses `createRun` wholesale — the ranking, the audit trail and the
   * exclusion reasons are identical to the exclusive path. Only what happens
   * *after* the round exists differs.
   */
  async broadcastInterest(supportRequestId: string): Promise<DispatchOutcome> {
    const now = this.deps.clock.now();
    const request = await this.requireRequest(supportRequestId);

    if (request.state !== "SEARCHING") {
      return { action: "NOT_SEARCHING", reason: `request is ${request.state}` };
    }
    if (now >= request.matchDeadlineAt) {
      await this.giveUp(request, "The 15-minute matching window closed.");
      return { action: "DEADLINE_PASSED", reason: "deadline passed" };
    }

    const elapsed = Math.floor((now.getTime() - request.createdAt.getTime()) / 1000);
    const level = scheduledLevel(elapsed, this.thresholds.relaxationScheduleSeconds);
    const run = await this.createRun(request, level, now);

    const outcome = await this.deps.interest?.openWindow(request);
    const reached = outcome?.action === "BROADCAST" ? outcome.reached : 0;

    if (reached === 0) {
      // Nobody to ask at this level. The relaxation ladder, not the interest
      // window, decides whether to widen or give up — same as exclusive mode.
      return this.handleEmptyPool(request, level, now);
    }

    // Every expert who was asked gets told, through the same doorbell the
    // exclusive path uses. The payload carries nothing; they re-fetch.
    const attempts = await this.deps.matching.listAttemptsForRequest(request.id);
    for (const attempt of attempts) {
      if (attempt.status !== "RANKED" || attempt.rank === null) continue;
      await this.notify?.offerOpened({
        expertProfileId: attempt.expertProfileId,
        supportRequestId: request.id,
        customerId: request.customerId,
        offeredAt: now,
      });
    }

    this.deps.logger.info("interest broadcast", {
      supportRequestId: request.id,
      runId: run.id,
      relaxationLevel: level,
      reached,
    });
    return { action: "OFFERED", reason: `broadcast to ${String(reached)}` };
  }

  /**
   * Closes the interest window and puts the shortlist in front of the customer.
   *
   * Nobody interested is not a failure — it is the same "pool is dry" situation
   * the exclusive loop meets when everyone declines, and it takes the same
   * route through the relaxation ladder.
   */
  async closeInterestWindow(supportRequestId: string): Promise<DispatchOutcome> {
    const now = this.deps.clock.now();
    const request = await this.requireRequest(supportRequestId);
    if (request.state !== "SEARCHING") {
      return { action: "NOT_SEARCHING", reason: `request is ${request.state}` };
    }
    if (!this.deps.interest) return { action: "NOT_SEARCHING", reason: "interest mode off" };

    const outcome = await this.deps.interest.closeWindow(request);
    if (outcome.action === "NO_INTEREST") {
      const elapsed = Math.floor((now.getTime() - request.createdAt.getTime()) / 1000);
      const level = scheduledLevel(elapsed, this.thresholds.relaxationScheduleSeconds);
      return this.handleEmptyPool(request, level, now);
    }
    if (outcome.action !== "SHORTLISTED") {
      return { action: "NOT_SEARCHING", reason: outcome.action };
    }

    await this.transition(request, "SHORTLISTED", {
      actorType: "SYSTEM",
      reason: `Interest window closed with ${String(outcome.candidates)} candidate(s).`,
      metadata: { candidates: outcome.candidates },
    });
    await this.notify?.requestStateChanged(request.id, request.customerId);

    return { action: "OFFERED", reason: `shortlisted ${String(outcome.candidates)}` };
  }

  /**
   * The customer picks one of the three.
   *
   * Authorization is ownership of the request, checked against the record rather
   * than trusted from the body — the attempt id alone must not let one customer
   * drive another's shortlist.
   */
  async selectCandidate(
    actor: Actor,
    supportRequestId: string,
    attemptId: string,
  ): Promise<MatchingAttemptRecord> {
    authorize(actor, "support_request:read_own");
    if (!this.deps.interest) {
      throw new ConflictError("Candidate selection is not enabled.", { attemptId });
    }

    const request = await this.requireRequest(supportRequestId);
    if (request.customerId !== actor.customerProfileId) {
      throw new ForbiddenError("support_request:read_own", `request:${supportRequestId}`);
    }
    if (request.state !== "SHORTLISTED") {
      throw new ConflictError("This request is no longer waiting for you to choose.", {
        state: request.state,
      });
    }

    const chosen = await this.deps.interest.select(supportRequestId, attemptId);

    await this.transition(request, "AWAITING_EXPERT_CONFIRMATION", {
      actorType: "CUSTOMER",
      actorUserId: actor.userId,
      reason: "Customer chose a candidate.",
      metadata: { attemptId: chosen.id },
    });

    // The chosen expert needs to know now — they have two minutes.
    await this.notify?.offerOpened({
      expertProfileId: chosen.expertProfileId,
      supportRequestId: request.id,
      customerId: request.customerId,
      offeredAt: this.deps.clock.now(),
    });

    return chosen;
  }

  /**
   * The chosen expert confirms, and both sides have now agreed.
   *
   * Deliberately mirrors `acceptOffer`: same transition, same assignment, same
   * supersede-and-complete. The difference is only which guard let it through.
   */
  async confirmSelection(actor: Actor, attemptId: string): Promise<MatchingAttemptRecord> {
    authorize(actor, "offer:respond");
    const now = this.deps.clock.now();
    const attempt = await this.requireOwnAttempt(actor, attemptId);

    if (attempt.status === "ACCEPTED") return attempt;
    if (attempt.status !== "CONFIRMING") {
      throw new ConflictError(this.closedOfferMessage(attempt), { status: attempt.status });
    }
    if (attempt.offerExpiresAt && now > attempt.offerExpiresAt) {
      // Honour the stored deadline, not the job — the same rule the offer
      // window follows.
      throw new ConflictError("Your two minutes ran out before your answer reached us.", {
        offerExpiresAt: attempt.offerExpiresAt.toISOString(),
      });
    }

    const request = await this.requireRequest(attempt.supportRequestId);
    const settled = await this.deps.matching.settleConfirmation({
      attemptId: attempt.id,
      expertProfileId: attempt.expertProfileId,
      toStatus: "ACCEPTED",
      now,
      releaseTo: "IN_SESSION",
    });
    if (!settled) {
      const current = await this.deps.matching.findAttemptById(attempt.id);
      throw new ConflictError(this.closedOfferMessage(current ?? attempt));
    }

    await this.transition(request, "ACCEPTED", {
      actorType: "EXPERT",
      actorUserId: actor.userId,
      reason: "Expert confirmed the customer's choice.",
      metadata: { attemptId: attempt.id },
    });
    await this.deps.requests.assignExpert({
      requestId: request.id,
      expertProfileId: attempt.expertProfileId,
      now,
    });

    // The other shortlisted experts are out. Recorded, not deleted.
    await this.deps.matching.supersedeRankedAttempts({
      matchingRunId: attempt.matchingRunId,
      now,
    });
    await this.deps.matching.completeRun({ matchingRunId: attempt.matchingRunId, now });
    await this.notify?.requestStateChanged(request.id, request.customerId);

    this.deps.logger.info("selection confirmed", {
      supportRequestId: request.id,
      attemptId: attempt.id,
      expertProfileId: attempt.expertProfileId,
    });
    return settled;
  }

  /**
   * The chosen expert let their two minutes lapse.
   *
   * Two outcomes, and they are different transitions: someone left means the
   * customer chooses again; nobody left means we search again. Returning the
   * customer to an empty shortlist would strand them.
   */
  async lapseConfirmation(attemptId: string): Promise<{ action: string }> {
    const now = this.deps.clock.now();
    if (!this.deps.interest) return { action: "NOT_ENABLED" };

    const attempt = await this.deps.matching.findAttemptById(attemptId);
    if (!attempt) return { action: "UNKNOWN_ATTEMPT" };
    if (attempt.status !== "CONFIRMING") {
      // Confirmed just before the timer, or already settled. Losing that race is
      // the correct outcome.
      return { action: "ALREADY_SETTLED" };
    }
    if (attempt.offerExpiresAt && now < attempt.offerExpiresAt) {
      // Fired early — a duplicate delivery. The stored deadline is the truth.
      return { action: "NOT_YET_DUE" };
    }

    return this.fallBackFromConfirmation({ attempt, now, decision: "TIMED_OUT" });
  }

  /**
   * The chosen expert says no, before their two minutes are up.
   *
   * Recorded as DECLINED rather than TIMED_OUT. The customer sees the same
   * thing either way — back to the shortlist — but the two are not the same
   * event: one is an answer and the other is silence, and an expert who
   * reliably answers "no" quickly should not accumulate the same history as one
   * who goes dark. Everything after the settle is shared with the lapse path,
   * because the *recovery* genuinely is identical.
   */
  async declineConfirmation(
    actor: Actor,
    attemptId: string,
    reason: DeclineReasonCode | null,
  ): Promise<MatchingAttemptRecord> {
    authorize(actor, "offer:respond");
    const now = this.deps.clock.now();
    const attempt = await this.requireOwnAttempt(actor, attemptId);

    if (attempt.status !== "CONFIRMING") {
      throw new ConflictError(this.closedOfferMessage(attempt), { status: attempt.status });
    }

    const settled = await this.deps.matching.findAttemptById(attemptId);
    await this.fallBackFromConfirmation({
      attempt,
      now,
      decision: "DECLINED",
      reason,
      actorUserId: actor.userId,
    });

    const after = await this.deps.matching.findAttemptById(attemptId);
    return after ?? settled ?? attempt;
  }

  /**
   * Settle a confirmation that will not become a session, and give the customer
   * back whatever is left.
   *
   * Shared by the timeout job and by an expert declining outright, so the two
   * cannot drift — the bug that would cause is a customer stranded on a dead
   * countdown because only one of the paths remembered to transition the
   * request.
   */
  private async fallBackFromConfirmation(params: {
    attempt: MatchingAttemptRecord;
    now: Date;
    decision: "TIMED_OUT" | "DECLINED";
    reason?: DeclineReasonCode | null;
    actorUserId?: string;
  }): Promise<{ action: string }> {
    const { attempt, now, decision } = params;
    if (!this.deps.interest) return { action: "NOT_ENABLED" };

    const settled = await this.deps.matching.settleConfirmation({
      attemptId: attempt.id,
      expertProfileId: attempt.expertProfileId,
      toStatus: decision,
      now,
      releaseTo: null,
      declineReason: params.reason ?? null,
    });
    if (!settled) return { action: "ALREADY_SETTLED" };

    const request = await this.requireRequest(attempt.supportRequestId);
    if (request.state !== "AWAITING_EXPERT_CONFIRMATION") {
      return { action: "NOT_AWAITING" };
    }

    const { exhausted } = await this.deps.interest.lapse(request.id, attempt.id);
    const said = decision === "DECLINED" ? "declined" : "did not confirm in time";
    // SYSTEM even when an expert triggered it. Coming off a dead confirmation is
    // a recovery the platform performs, and the state machine reserves the
    // transition accordingly; the expert is still attributed through
    // `actorUserId` and the reason, which is where an auditor looks anyway.
    const actorType = "SYSTEM" as const;

    if (exhausted) {
      await this.transition(request, "SHORTLISTED", {
        actorType,
        actorUserId: params.actorUserId,
        reason: `The chosen expert ${said} and nobody is left on the shortlist.`,
      });
      const back = await this.requireRequest(request.id);
      await this.transition(back, "SEARCHING", {
        actorType: "SYSTEM",
        reason: "Shortlist exhausted; searching again.",
      });
      await this.notify?.requestStateChanged(request.id, request.customerId);
      return { action: "RESEARCHING" };
    }

    await this.transition(request, "SHORTLISTED", {
      actorType,
      actorUserId: params.actorUserId,
      reason: `The chosen expert ${said}.`,
      metadata: { attemptId: attempt.id },
    });
    await this.notify?.requestStateChanged(request.id, request.customerId);
    return { action: "BACK_TO_SHORTLIST" };
  }

  /** Sweeps confirmations whose stored deadline has passed. Backstop for lost jobs. */
  async reconcileLapsedConfirmations(limit = 25): Promise<{ lapsed: number }> {
    if (!this.deps.interest) return { lapsed: 0 };
    const overdue = await this.deps.interest.lapsedConfirmations(limit);
    let lapsed = 0;
    for (const attempt of overdue) {
      const result = await this.lapseConfirmation(attempt.id);
      if (result.action === "BACK_TO_SHORTLIST" || result.action === "RESEARCHING") lapsed += 1;
    }
    return { lapsed };
  }

  async acceptOffer(actor: Actor, attemptId: string): Promise<MatchingAttemptRecord> {
    authorize(actor, "offer:respond");
    const now = this.deps.clock.now();
    const attempt = await this.requireOwnAttempt(actor, attemptId);

    if (attempt.status === "ACCEPTED") return attempt;
    if (attempt.status !== "OFFERED") {
      throw new ConflictError(this.closedOfferMessage(attempt), { status: attempt.status });
    }
    if (attempt.offerExpiresAt && now > attempt.offerExpiresAt) {
      // The window closed even though the timeout job has not landed yet.
      // Honour the deadline, not the job.
      throw new ConflictError(
        "That offer expired before your answer reached us. It has gone to another expert.",
        { offerExpiresAt: attempt.offerExpiresAt.toISOString() },
      );
    }

    const request = await this.requireRequest(attempt.supportRequestId);

    const closed = await this.deps.matching.closeOffer({
      attemptId: attempt.id,
      expertProfileId: attempt.expertProfileId,
      toStatus: "ACCEPTED",
      now,
      countAgainstReliability: true,
      // Committed to this request; not offerable to anything else.
      releaseTo: "IN_SESSION",
    });
    if (!closed) {
      const current = await this.deps.matching.findAttemptById(attempt.id);
      throw new ConflictError(this.closedOfferMessage(current ?? attempt));
    }

    await this.transition(request, "ACCEPTED", {
      actorType: "EXPERT",
      actorUserId: actor.userId,
      reason: "Expert accepted the offer.",
      metadata: { attemptId: attempt.id, origin: attempt.origin },
    });
    await this.deps.requests.assignExpert({
      requestId: request.id,
      expertProfileId: attempt.expertProfileId,
      now,
    });

    // Nothing else in this run can be offered now.
    await this.deps.matching.supersedeRankedAttempts({ matchingRunId: attempt.matchingRunId, now });
    await this.deps.matching.completeRun({ matchingRunId: attempt.matchingRunId, now });

    this.deps.logger.info("offer accepted", {
      supportRequestId: request.id,
      attemptId: attempt.id,
      expertProfileId: attempt.expertProfileId,
      origin: attempt.origin,
      responseSeconds: closed.responseSeconds,
    });

    this.notify?.timing(TIMING_POINTS.EXPERT_ACCEPTED, {
      supportRequestId: request.id,
      attemptId: attempt.id,
      // The number that matters for the 60-second question: how long the human
      // actually took, from the offer landing to them clicking.
      responseSeconds: closed.responseSeconds,
      sinceSubmittedMs: now.getTime() - request.createdAt.getTime(),
    });
    await this.notify?.offerClosed({
      expertProfileId: attempt.expertProfileId,
      supportRequestId: request.id,
      customerId: request.customerId,
    });

    return closed;
  }

  /**
   * Decline (requirements 9 and 10).
   *
   * The reason is optional, always. An expert who must justify saying no starts
   * saying yes to work they should not take, and the whole product rests on
   * them not doing that. What we do insist on is that a decline is recorded as
   * a **decline** — `TIMED_OUT` is a different row, written by a different
   * path, and the two are never conflated.
   */
  async declineOffer(
    actor: Actor,
    attemptId: string,
    input: { reason?: DeclineReasonCode | null; note?: string | null } = {},
  ): Promise<MatchingAttemptRecord> {
    authorize(actor, "offer:respond");
    const now = this.deps.clock.now();
    const attempt = await this.requireOwnAttempt(actor, attemptId);

    if (attempt.status === "DECLINED") return attempt;
    if (attempt.status !== "OFFERED") {
      throw new ConflictError(this.closedOfferMessage(attempt), { status: attempt.status });
    }
    if (input.note && input.note.length > 500) {
      throw new ValidationError("That note is too long.", {
        note: ["Keep it under 500 characters."],
      });
    }

    const closed = await this.deps.matching.closeOffer({
      attemptId: attempt.id,
      expertProfileId: attempt.expertProfileId,
      toStatus: "DECLINED",
      now,
      declineReason: input.reason ?? null,
      declineNote: input.note ?? null,
      countAgainstReliability: true,
      releaseTo: "AVAILABLE",
    });
    if (!closed) {
      const current = await this.deps.matching.findAttemptById(attempt.id);
      throw new ConflictError(this.closedOfferMessage(current ?? attempt));
    }

    this.deps.logger.info("offer declined", {
      supportRequestId: attempt.supportRequestId,
      attemptId: attempt.id,
      expertProfileId: attempt.expertProfileId,
      declineReason: input.reason ?? null,
    });

    await this.notifyOfferClosed(attempt);
    await this.returnToSearching(attempt.supportRequestId, "Expert declined.", now);
    return closed;
  }

  /**
   * The 60-second timeout (requirements 8 and 10).
   *
   * Three things this does *not* do, each deliberate:
   *
   *   - It does not compute a deadline. `offerExpiresAt` was stored when the
   *     offer opened; if the job arrives early — a duplicate delivery, a worker
   *     that restarted and replayed — it re-schedules for the remaining time
   *     rather than expiring the offer or extending the window.
   *   - It does not treat the timeout as a decline. Separate status, separate
   *     meaning: silence is not an answer.
   *   - It does not touch `matchDeadlineAt`. An offer expiring buys the
   *     customer nothing (requirement 7).
   */
  async expireOffer(attemptId: string): Promise<{ expired: boolean; reason: string }> {
    const now = this.deps.clock.now();
    const attempt = await this.deps.matching.findAttemptById(attemptId);
    if (!attempt) return { expired: false, reason: "attempt no longer exists" };
    if (attempt.status !== "OFFERED") {
      return { expired: false, reason: `attempt is ${attempt.status}` };
    }

    if (attempt.offerExpiresAt && now < attempt.offerExpiresAt) {
      const remaining = Math.ceil((attempt.offerExpiresAt.getTime() - now.getTime()) / 1000);
      this.deps.logger.warn("offer timeout fired early; re-scheduling, not extending", {
        attemptId,
        remainingSeconds: remaining,
      });
      await this.deps.scheduler.enqueue({
        queue: this.deps.queues.offerTimeout,
        payload: { supportRequestId: attempt.supportRequestId, matchingAttemptId: attempt.id },
        runAfterSeconds: remaining,
        singletonKey: `offer-timeout:${attempt.id}:retry`,
      });
      return { expired: false, reason: "window has not closed yet" };
    }

    const closed = await this.deps.matching.closeOffer({
      attemptId: attempt.id,
      expertProfileId: attempt.expertProfileId,
      toStatus: "TIMED_OUT",
      now,
      countAgainstReliability: true,
      releaseTo: "AVAILABLE",
    });
    if (!closed) return { expired: false, reason: "the expert answered first" };

    this.deps.logger.info("offer timed out", {
      supportRequestId: attempt.supportRequestId,
      attemptId: attempt.id,
      expertProfileId: attempt.expertProfileId,
    });

    await this.notifyOfferClosed(attempt);
    await this.returnToSearching(attempt.supportRequestId, "Offer timed out.", now);
    return { expired: true, reason: "offer window elapsed" };
  }

  /**
   * The 15-minute backstop (requirement 7).
   *
   * Measured from submission to **acceptance**, not to the last offer. A
   * request still searching or still holding an open offer at the deadline is
   * given up on.
   */
  async expireMatching(supportRequestId: string): Promise<{ gaveUp: boolean; reason: string }> {
    const now = this.deps.clock.now();
    const request = await this.deps.requests.findById(supportRequestId);
    if (!request) return { gaveUp: false, reason: "request no longer exists" };

    if (request.state !== "SEARCHING" && request.state !== "OFFERED") {
      return { gaveUp: false, reason: `request is ${request.state}` };
    }
    if (now < request.matchDeadlineAt) {
      return { gaveUp: false, reason: "deadline has not passed" };
    }

    const open = await this.deps.matching.findOpenOffer(supportRequestId);
    if (open) {
      // An offer still on the table at the deadline is withdrawn, not counted
      // against the expert — they may have been about to accept.
      await this.deps.matching.closeOffer({
        attemptId: open.id,
        expertProfileId: open.expertProfileId,
        toStatus: "WITHDRAWN",
        now,
        countAgainstReliability: false,
        releaseTo: "AVAILABLE",
      });
    }

    await this.giveUp(request, "The 15-minute matching window elapsed.");
    return { gaveUp: true, reason: "deadline passed" };
  }

  // ── Requirement 14: experts who become ineligible mid-offer ────────────────

  /**
   * Withdraw offers held by experts who should no longer hold them.
   *
   * Runs on the worker's janitor cadence alongside the presence sweep. Phase 4
   * left `ON_OFFER` alone because it had nothing to re-dispatch with; this is
   * the other half of that decision.
   *
   * Withdrawal never counts against the expert. Being suspended, or losing
   * connectivity, is not a decline.
   */
  async reconcileStaleOffers(limit = 50): Promise<{ withdrawn: number }> {
    const now = this.deps.clock.now();
    const staleBefore = new Date(now.getTime() - this.thresholds.offerPresenceGraceSeconds * 1000);
    const rows = await this.deps.matching.listOffersNeedingReconciliation({ staleBefore, limit });

    let withdrawn = 0;
    for (const row of rows) {
      const closed = await this.deps.matching.closeOffer({
        attemptId: row.attempt.id,
        expertProfileId: row.attempt.expertProfileId,
        toStatus: "WITHDRAWN",
        now,
        countAgainstReliability: false,
        // Suspended or gone: OFFLINE, not back into the pool.
        releaseTo: "OFFLINE",
      });
      if (!closed) continue;

      withdrawn += 1;
      this.deps.logger.warn("withdrew an offer from an expert who became ineligible", {
        supportRequestId: row.attempt.supportRequestId,
        attemptId: row.attempt.id,
        expertProfileId: row.attempt.expertProfileId,
        expertStatus: row.expertStatus,
        availabilityStatus: row.availabilityStatus,
      });

      await this.notifyOfferClosed(row.attempt);
      // The request must not be left holding an offer nobody will answer.
      await this.returnToSearching(
        row.attempt.supportRequestId,
        "The expert became unavailable while the offer was open.",
        now,
      );
    }

    return { withdrawn };
  }

  /**
   * Re-dispatch requests that stalled (requirement 14).
   *
   * §17 rules out polling as the *dispatch mechanism*; this is a janitor, like
   * the Phase 3 classification sweep. Without it a lost enqueue means a paying
   * customer waits out the full 15 minutes for a `NO_EXPERT_FOUND` that a live
   * bench would have answered immediately — technically not stranded, but not an
   * acceptable outcome either.
   */
  async recoverStalledSearches(limit = 25): Promise<{ recovered: number }> {
    const now = this.deps.clock.now();
    // Generous: a healthy dispatch completes in well under the offer window, so
    // anything quiet for longer than one window has genuinely stalled.
    const stalledBefore = new Date(now.getTime() - this.thresholds.offerWindowSeconds * 1000);
    const ids = await this.deps.matching.listStalledSearches({ stalledBefore, limit });

    let recovered = 0;
    for (const id of ids) {
      this.deps.logger.warn("re-dispatching a stalled search", { supportRequestId: id });
      const outcome = await this.dispatchNextOffer(id);
      if (outcome.action === "OFFERED" || outcome.action === "NO_EXPERT_FOUND") recovered += 1;
    }
    return { recovered };
  }

  // ── Stage 4b: admin dispatch (requirements 12 and 13) ──────────────────────

  /**
   * Assign — offer to a specific candidate, ranking bypassed but rules intact.
   *
   * The operator is choosing *who*, not overriding *whether*. The expert must
   * be approved, available and present, and must still accept. A reason is
   * required because a manual intervention that nobody can explain later is
   * indistinguishable from a bug.
   */
  async adminAssign(
    actor: Actor,
    params: { supportRequestId: string; expertProfileId: string; reason: string },
  ): Promise<MatchingAttemptRecord> {
    authorize(actor, "matching:admin_assign");
    return this.adminOffer(actor, { ...params, origin: "ADMIN_ASSIGN" });
  }

  /**
   * Force Assign — override the algorithm's constraints entirely.
   *
   * Skips scoring, ranking, competence, and the availability requirement. For
   * the case where an operator has already reached the expert out-of-band and
   * needs the system to catch up.
   *
   * What it does **not** skip is consent. §C5 originally sent force-assign
   * straight to ACCEPTED; the user overruled that in Phase 2 and the rule is
   * now absolute — an expert is never committed to a session they did not
   * agree to, whoever is asking. The offer arrives with the normal 60-second
   * window and the normal accept/decline buttons.
   */
  async adminForceAssign(
    actor: Actor,
    params: { supportRequestId: string; expertProfileId: string; reason: string },
  ): Promise<MatchingAttemptRecord> {
    authorize(actor, "matching:admin_force_assign");
    return this.adminOffer(actor, { ...params, origin: "ADMIN_FORCE_ASSIGN" });
  }

  private async adminOffer(
    actor: Actor,
    params: {
      supportRequestId: string;
      expertProfileId: string;
      reason: string;
      origin: Extract<AttemptOrigin, "ADMIN_ASSIGN" | "ADMIN_FORCE_ASSIGN">;
    },
  ): Promise<MatchingAttemptRecord> {
    const now = this.deps.clock.now();
    const reason = params.reason.trim();
    if (reason.length === 0) {
      throw new ValidationError("Record why you are assigning this manually.", {
        reason: ["A reason is required."],
      });
    }

    const request = await this.requireRequest(params.supportRequestId);
    if (request.state !== "SEARCHING" && request.state !== "OFFERED") {
      throw new ConflictError(
        `This request is ${request.state}. Manual assignment only applies while it is still being matched.`,
      );
    }

    const held = await this.deps.matching.findOpenOfferForExpert(params.expertProfileId);
    if (held) {
      throw new ConflictError(
        "That expert already has an open offer. Wait for them to answer it, or pick someone else.",
        { attemptId: held.id },
      );
    }

    // Re-assigning over a live offer supersedes it rather than racing it. The
    // superseded expert is not penalised — they were not given their 60 seconds.
    const openOffer = await this.deps.matching.findOpenOffer(request.id);
    if (openOffer) {
      await this.deps.matching.closeOffer({
        attemptId: openOffer.id,
        expertProfileId: openOffer.expertProfileId,
        toStatus: "SUPERSEDED",
        now,
        countAgainstReliability: false,
        releaseTo: "AVAILABLE",
      });
    }

    let run = await this.deps.matching.latestRunForRequest(request.id);
    run ??= await this.createRun(request, 0, now);

    const attempt = await this.deps.matching.createAdminAttempt({
      matchingRunId: run.id,
      supportRequestId: request.id,
      expertProfileId: params.expertProfileId,
      origin: params.origin,
      adminReason: reason,
      now,
    });

    const offerExpiresAt = new Date(now.getTime() + this.thresholds.offerWindowSeconds * 1000);
    const opened = await this.deps.matching.openOffer({
      attemptId: attempt.id,
      expertProfileId: params.expertProfileId,
      now,
      // An admin assignment may legitimately outlive the matching deadline —
      // the operator has taken over from the automation.
      offerExpiresAt,
    });
    if (!opened) {
      throw new ConflictError(
        "Could not offer to that expert — their availability changed. Reload and try again.",
      );
    }

    // OFFERED → OFFERED is a legal admin move; SEARCHING → OFFERED is the
    // ordinary one. Both are in the §16 table.
    await this.transition(await this.requireRequest(request.id), "OFFERED", {
      actorType: "ADMIN",
      actorUserId: actor.userId,
      reason,
      metadata: { attemptId: opened.id, origin: params.origin },
    });

    await this.scheduleOfferTimeout(opened, now);

    // Requirement 13. The attempt's `origin` already distinguishes it forever;
    // the audit row is what makes *who and why* answerable.
    await this.deps.auditLog.record({
      actorUserId: actor.userId,
      actorType: "ADMIN",
      action:
        params.origin === "ADMIN_FORCE_ASSIGN" ? "matching.force_assigned" : "matching.assigned",
      entityType: "SupportRequest",
      entityId: request.id,
      before: { state: request.state, assignedExpertId: request.assignedExpertId },
      after: {
        expertProfileId: params.expertProfileId,
        attemptId: opened.id,
        origin: params.origin,
        reason,
        supersededAttemptId: openOffer?.id ?? null,
        adminEmail: actor.email,
        at: now.toISOString(),
        note: "The expert must still accept. Manual assignment does not bypass consent.",
      },
    });

    this.deps.logger.warn("manual dispatch", {
      supportRequestId: request.id,
      expertProfileId: params.expertProfileId,
      origin: params.origin,
      adminUserId: actor.userId,
    });

    return opened;
  }

  // ── Shared ─────────────────────────────────────────────────────────────────

  /** Back to SEARCHING, then re-dispatch — unless the deadline has passed. */
  private async returnToSearching(
    supportRequestId: string,
    reason: string,
    now: Date,
  ): Promise<void> {
    const request = await this.deps.requests.findById(supportRequestId);
    if (!request || request.state !== "OFFERED") return;

    if (now >= request.matchDeadlineAt) {
      await this.giveUp(request, "The 15-minute matching window elapsed.");
      return;
    }

    await this.transition(request, "SEARCHING", { actorType: "SYSTEM", reason });
    await this.notify?.requestStateChanged(supportRequestId, request.customerId);
    await this.deps.scheduler.enqueue({
      queue: this.deps.queues.dispatchNextOffer,
      payload: { supportRequestId },
    });
  }

  private async giveUp(request: SupportRequestRecord, reason: string): Promise<void> {
    if (request.state !== "SEARCHING" && request.state !== "OFFERED") return;
    await this.transition(request, "NO_EXPERT_FOUND", { actorType: "SYSTEM", reason });
    this.deps.logger.warn("no expert found", { supportRequestId: request.id, reason });
    // Requirement 5: the customer should not be left watching a spinner that
    // will never resolve.
    await this.notify?.requestStateChanged(request.id, request.customerId);
  }

  private secondsUntilNextLevel(level: number, createdAt: Date, now: Date): number {
    const engagesAt =
      createdAt.getTime() +
      engagesAtSeconds(level, this.thresholds.relaxationScheduleSeconds) * 1000;
    // Floor of 2s rather than 5s: with a 90-second first step, a five-second
    // minimum was a meaningful slice of the wait it was rounding.
    return Math.max(2, Math.ceil((engagesAt - now.getTime()) / 1000));
  }

  private async transition(
    request: SupportRequestRecord,
    to: SupportRequestRecord["state"],
    options: {
      actorType: "SYSTEM" | "CUSTOMER" | "EXPERT" | "ADMIN";
      actorUserId?: string;
      reason?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<SupportRequestRecord> {
    assertTransition(request.state, to, options.actorType);
    const updated = await this.deps.requests.applyTransition({
      requestId: request.id,
      fromState: request.state,
      toState: to,
      now: this.deps.clock.now(),
      expectedVersion: request.version,
      actorType: options.actorType,
      actorUserId: options.actorUserId ?? null,
      reason: options.reason ?? null,
      ...(options.metadata ? { metadata: options.metadata } : {}),
    });
    if (!updated) {
      throw new ConflictError("This request changed while it was being matched.", {
        requestId: request.id,
        expectedVersion: request.version,
      });
    }
    return updated;
  }

  /**
   * Signals an offer closing, looking up the customer to address their channel.
   *
   * The lookup is cheap and skipped entirely when there is no notifier. Reading a
   * row for a notification is acceptable; failing an expert's decline because the
   * read failed is not, which is why it is nullable rather than required.
   */
  private async notifyOfferClosed(attempt: MatchingAttemptRecord): Promise<void> {
    if (!this.notify) return;
    const request = await this.deps.requests.findById(attempt.supportRequestId);
    await this.notify.offerClosed({
      expertProfileId: attempt.expertProfileId,
      supportRequestId: attempt.supportRequestId,
      customerId: request?.customerId ?? "",
    });
  }

  private async requireRequest(id: string): Promise<SupportRequestRecord> {
    const request = await this.deps.requests.findById(id);
    if (!request) throw new NotFoundError("SupportRequest", id);
    return request;
  }

  private async requireOwnAttempt(actor: Actor, attemptId: string): Promise<MatchingAttemptRecord> {
    const attempt = await this.deps.matching.findAttemptById(attemptId);
    if (!attempt) throw new NotFoundError("MatchingAttempt", attemptId);
    // Ownership from the row, never from the request.
    if (!actor.expert || actor.expert.profileId !== attempt.expertProfileId) {
      throw new ForbiddenError("respond to this offer", `attempt:${attemptId}`);
    }
    return attempt;
  }

  private closedOfferMessage(attempt: MatchingAttemptRecord): string {
    switch (attempt.status) {
      case "TIMED_OUT":
        return "That offer ran out of time and has gone to another expert.";
      case "DECLINED":
        return "You already declined this one.";
      case "ACCEPTED":
        return "You already accepted this one.";
      case "SUPERSEDED":
      case "WITHDRAWN":
        return "That offer was withdrawn before you answered.";
      default:
        return "That offer is no longer open.";
    }
  }
}

/** The category of a required skill, read off whichever candidate declared it. */
function categoryOf(
  skillId: string,
  rows: readonly { candidate: { skills: readonly { skillId: string; categoryId: string }[] } }[],
): string | undefined {
  for (const row of rows) {
    const match = row.candidate.skills.find((skill) => skill.skillId === skillId);
    if (match) return match.categoryId;
  }
  return undefined;
}

export type { ExclusionReason, AvailabilityStatus };
