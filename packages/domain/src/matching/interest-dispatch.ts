import type { Actor } from "../authorization/index.js";
import { authorize } from "../authorization/index.js";
import type { Clock } from "../ports/clock.js";
import type { Logger } from "../ports/logger.js";
import type { JobScheduler } from "../ports/request-repositories.js";
import type { MatchingAttemptRecord, MatchingRepository } from "../ports/matching-repositories.js";
import type { SupportRequestRecord } from "../ports/request-repositories.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../shared/errors.js";
import {
  confirmationDeadline,
  EXPERT_CONFIRM_SECONDS,
  selectShortlist,
  shortlistAfterLapse,
  shouldCloseInterestWindow,
  SHORTLIST_SIZE,
} from "./shortlist.js";

/**
 * The interest-pool dispatch loop.
 *
 * Sits beside the exclusive offer loop rather than replacing it — both paths are
 * legal in the state machine, and which one runs is a composition-root choice
 * (`DISPATCH_MODE`). Keeping both means the existing regression suites still
 * mean something while this one is exercised.
 *
 * ```
 *   SEARCHING ─broadcast─▶ (experts raise hands) ─window closes─▶ SHORTLISTED
 *        ▲                                                            │
 *        │                                                    customer picks
 *        │                                                            ▼
 *        └──────── nobody left ──────── lapse ──── AWAITING_EXPERT_CONFIRMATION
 *                                                                     │
 *                                                            expert confirms
 *                                                                     ▼
 *                                                                 ACCEPTED
 * ```
 *
 * ## What this deliberately does not do
 *
 * It does not rank. `createRun` already produced a ranked, audited round, and
 * this reuses it wholesale — the shortlist is a *filter* over that ranking, never
 * a second opinion about who is best. That is what keeps "why these three?"
 * answerable from the same audit trail as "why this one?".
 *
 * ## Every step is idempotent
 *
 * Each guard is expressed as a status precondition in the repository, so a
 * replayed job or a double-clicked button is a no-op rather than a second
 * effect. Two customers cannot both select; an expert cannot answer twice; a
 * lapse that races a confirmation loses.
 */

export interface InterestDispatchDeps {
  readonly matching: MatchingRepository;
  readonly scheduler: JobScheduler;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly queues: {
    readonly interestWindowClose: string;
    readonly confirmationTimeout: string;
  };
  readonly broadcastSize: number;
  readonly interestWindowSeconds: number;
}

export type InterestOutcome =
  | { readonly action: "BROADCAST"; readonly reached: number }
  | { readonly action: "SHORTLISTED"; readonly candidates: number }
  | { readonly action: "NO_INTEREST" }
  | { readonly action: "WINDOW_STILL_OPEN"; readonly interested: number }
  | { readonly action: "NOT_SEARCHING"; readonly reason: string };

export class InterestDispatch {
  constructor(private readonly deps: InterestDispatchDeps) {}

  /**
   * Opens the interest window on an already-ranked round.
   *
   * The attempts are already RANKED from `createRun`; broadcasting is therefore
   * about *notifying* the top N and scheduling the close, not about writing new
   * rows. That is why there is no "BROADCAST" attempt status — being ranked
   * inside the cap already means "was asked".
   */
  async openWindow(request: SupportRequestRecord): Promise<InterestOutcome> {
    if (request.state !== "SEARCHING") {
      return { action: "NOT_SEARCHING", reason: `request is ${request.state}` };
    }

    const now = this.deps.clock.now();
    await this.deps.scheduler.enqueue({
      queue: this.deps.queues.interestWindowClose,
      payload: { supportRequestId: request.id },
      runAfterSeconds: this.deps.interestWindowSeconds,
      // One close per request. A re-entry into SEARCHING must not schedule a
      // second one that would shortlist a round already settled.
      singletonKey: `interest-close:${request.id}`,
    });

    const ranked = await this.deps.matching.listAttemptsForRequest(request.id);
    const reached = ranked.filter(
      (attempt) =>
        attempt.status === "RANKED" &&
        attempt.rank !== null &&
        attempt.rank <= this.deps.broadcastSize,
    ).length;

    this.deps.logger.info("interest window opened", {
      supportRequestId: request.id,
      reached,
      windowSeconds: this.deps.interestWindowSeconds,
      closesAt: new Date(now.getTime() + this.deps.interestWindowSeconds * 1000).toISOString(),
    });

    return { action: "BROADCAST", reached };
  }

  /** What this expert has been asked about and not yet answered. */
  async opportunitiesFor(actor: Actor): Promise<readonly MatchingAttemptRecord[]> {
    authorize(actor, "offer:read_own");
    // `offer:read_own` already requires an approved workspace, so a profile is
    // guaranteed here. Throwing rather than returning [] keeps the failure mode
    // identical to `respond` instead of silently looking like "no work".
    const expertProfileId = actor.expert?.profileId;
    if (!expertProfileId) {
      throw new ForbiddenError("offer:read_own", `user:${actor.userId}`);
    }
    return this.deps.matching.listInterestOpportunities({
      expertProfileId,
      maxRank: this.deps.broadcastSize,
      now: this.deps.clock.now(),
    });
  }

  /**
   * An expert raises a hand, or passes.
   *
   * Interest is deliberately cheap and binds nobody — an expert may be
   * interested in several requests at once. It is not an acceptance, so it does
   * not touch their availability and a pass costs no reliability.
   *
   * Answering twice is a no-op rather than an error: a double-clicked button
   * should not produce a 409 the expert has to interpret.
   */
  async respond(
    actor: Actor,
    attemptId: string,
    interested: boolean,
  ): Promise<{ changed: boolean }> {
    authorize(actor, "offer:respond");
    const expertProfileId = actor.expert?.profileId;
    if (!expertProfileId) {
      throw new ForbiddenError("offer:respond", `user:${actor.userId}`);
    }

    const result = await this.deps.matching.recordInterest({
      attemptId,
      expertProfileId,
      interested,
      now: this.deps.clock.now(),
    });

    if (result.changed) {
      this.deps.logger.info("interest recorded", { attemptId, expertProfileId, interested });
    }
    return result;
  }

  /**
   * Should the window close now?
   *
   * Two ways: enough hands are up, or the window has run out with at least one.
   * The second is what stops a thin bench leaving the customer on a spinner.
   */
  async shouldClose(request: SupportRequestRecord): Promise<boolean> {
    const interested = await this.deps.matching.listInterested(request.id);
    const elapsed = Math.floor(
      (this.deps.clock.now().getTime() - request.createdAt.getTime()) / 1000,
    );
    return shouldCloseInterestWindow({
      interestedCount: interested.length,
      windowElapsedSeconds: elapsed,
      windowSeconds: this.deps.interestWindowSeconds,
    });
  }

  /**
   * Closes the window and assembles the shortlist.
   *
   * Returns NO_INTEREST when nobody raised a hand — the caller decides whether
   * that means relax and re-broadcast or give up, because that policy belongs
   * with the relaxation ladder rather than here.
   */
  async closeWindow(request: SupportRequestRecord): Promise<InterestOutcome> {
    if (request.state !== "SEARCHING") {
      return { action: "NOT_SEARCHING", reason: `request is ${request.state}` };
    }

    const now = this.deps.clock.now();
    const interested = await this.deps.matching.listInterested(request.id);
    if (interested.length === 0) return { action: "NO_INTEREST" };

    // The ranking already decided the order; this filters it, never re-sorts it.
    const ranked = (await this.deps.matching.listAttemptsForRequest(request.id))
      .filter((attempt) => attempt.rank !== null)
      .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
      .map((attempt) => ({
        expertProfileId: attempt.expertProfileId,
        userId: "",
        rank: attempt.rank ?? 0,
        score: attempt.finalScore,
      }));

    const decision = selectShortlist(
      ranked as never,
      interested.map((attempt) => attempt.expertProfileId),
      SHORTLIST_SIZE,
    );
    const chosenExpertIds = new Set(
      decision.shortlisted.map((candidate) => candidate.expertProfileId),
    );
    const attemptIds = interested
      .filter((attempt) => chosenExpertIds.has(attempt.expertProfileId))
      .map((attempt) => attempt.id);

    const count = await this.deps.matching.markShortlisted({
      supportRequestId: request.id,
      attemptIds,
      now,
    });

    this.deps.logger.info("shortlist assembled", {
      supportRequestId: request.id,
      interested: interested.length,
      shortlisted: count,
    });

    return { action: "SHORTLISTED", candidates: count };
  }

  /** The three (or fewer) the customer is choosing between. */
  async shortlistFor(supportRequestId: string): Promise<readonly MatchingAttemptRecord[]> {
    return this.deps.matching.listShortlisted(supportRequestId);
  }

  /**
   * The customer picks one, opening that expert's two-minute window.
   *
   * The deadline is stored on the attempt, not held by the scheduled job: a
   * worker restart, a duplicate delivery or a page refresh must not hand anyone
   * a fresh two minutes. The job only *reads* the stored deadline.
   *
   * Guarded on SHORTLISTED, so a second selection — or one naming an expert who
   * has already lapsed — returns null rather than re-opening a window.
   */
  async select(supportRequestId: string, attemptId: string): Promise<MatchingAttemptRecord> {
    const now = this.deps.clock.now();
    const shortlisted = await this.deps.matching.listShortlisted(supportRequestId);

    const chosen = shortlisted.find((attempt) => attempt.id === attemptId);
    if (!chosen) throw new NotFoundError("MatchingAttempt", attemptId);
    if (shortlisted.some((attempt) => attempt.status === "CONFIRMING")) {
      throw new ConflictError("Someone is already being asked to confirm this request.", {
        attemptId,
      });
    }

    const expiresAt = confirmationDeadline(now, EXPERT_CONFIRM_SECONDS);
    const updated = await this.deps.matching.startConfirmation({
      attemptId,
      expertProfileId: chosen.expertProfileId,
      expiresAt,
      now,
    });
    if (!updated) {
      throw new ConflictError("That expert is no longer available to confirm.", { attemptId });
    }

    await this.deps.scheduler.enqueue({
      queue: this.deps.queues.confirmationTimeout,
      payload: { attemptId, supportRequestId },
      runAfterSeconds: EXPERT_CONFIRM_SECONDS,
      singletonKey: `confirm-timeout:${attemptId}`,
    });

    this.deps.logger.info("candidate selected; confirmation window open", {
      supportRequestId,
      attemptId,
      expiresAt: expiresAt.toISOString(),
    });

    return updated;
  }

  /**
   * What is left after the chosen expert lets their window lapse.
   *
   * Returns the remaining shortlist and whether it is now empty, because those
   * are two different transitions — "ask again" versus "search again" — and
   * getting them the wrong way round strands the customer on an empty screen.
   */
  async lapse(
    supportRequestId: string,
    attemptId: string,
  ): Promise<{ remaining: readonly MatchingAttemptRecord[]; exhausted: boolean }> {
    const shortlisted = await this.deps.matching.listShortlisted(supportRequestId);
    const lapsed = shortlisted.find((attempt) => attempt.id === attemptId);
    if (!lapsed) {
      // Already settled — the expert confirmed just before the timer fired, or
      // the request moved on. Losing that race is the correct outcome.
      return { remaining: shortlisted, exhausted: false };
    }

    const result = shortlistAfterLapse(
      shortlisted.map((attempt) => ({
        expertProfileId: attempt.expertProfileId,
        userId: "",
        rank: attempt.rank ?? 0,
        score: attempt.finalScore,
      })) as never,
      lapsed.expertProfileId,
    );

    const remaining = shortlisted.filter((attempt) => attempt.id !== attemptId);
    this.deps.logger.info("confirmation lapsed", {
      supportRequestId,
      attemptId,
      remaining: remaining.length,
      exhausted: result.exhausted,
    });

    return { remaining, exhausted: remaining.length === 0 };
  }

  /** Confirmations whose stored deadline has passed. Drives the sweeper. */
  async lapsedConfirmations(limit = 25): Promise<readonly MatchingAttemptRecord[]> {
    return this.deps.matching.listLapsedConfirmations({ now: this.deps.clock.now(), limit });
  }
}
