import type { AvailabilityStatus } from "@sfx/contracts";
import { authorize, type Actor } from "../authorization/index.js";
import type { Clock } from "../ports/clock.js";
import type { Logger } from "../ports/logger.js";
import type {
  AvailabilityLogEntry,
  ExpertAvailabilityRepository,
  ExpertPresenceRecord,
} from "../ports/expert-repositories.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../shared/errors.js";
import {
  assertAvailabilityTransition,
  canGoAvailable,
  DEFAULT_HEARTBEAT_STALE_AFTER_SECONDS,
  evaluateEligibility,
  secondsSinceHeartbeat,
  type EligibilityResult,
} from "./availability.js";

/**
 * The availability toggle, presence, and the stale sweep (§11).
 *
 * Three requirements meet here and each is enforced at this layer rather than
 * in the UI, so the mobile client (requirement 9) inherits all of them:
 *
 * - **3.** Only an APPROVED expert may go AVAILABLE.
 * - **4.** Being AVAILABLE is not the same as being matchable.
 * - **5.** A sweep is sticky: a heartbeat never resurrects an offline expert.
 */

export interface AvailabilityView {
  readonly availabilityStatus: AvailabilityStatus;
  readonly lastHeartbeatAt: Date | null;
  readonly secondsSinceHeartbeat: number | null;
  readonly heartbeatStaleAfterSeconds: number;
  readonly heartbeatIntervalSeconds: number;
  readonly eligibility: EligibilityResult;
}

export interface AvailabilityServiceDeps {
  readonly availability: ExpertAvailabilityRepository;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly heartbeatStaleAfterSeconds?: number;
  readonly heartbeatIntervalSeconds?: number;
}

export class ExpertAvailabilityService {
  private readonly staleAfter: number;
  private readonly interval: number;

  constructor(private readonly deps: AvailabilityServiceDeps) {
    this.staleAfter = deps.heartbeatStaleAfterSeconds ?? DEFAULT_HEARTBEAT_STALE_AFTER_SECONDS;
    this.interval = deps.heartbeatIntervalSeconds ?? 45;
  }

  async getOwn(actor: Actor): Promise<AvailabilityView> {
    authorize(actor, "expert_availability:read_own");
    const presence = await this.requireOwnPresence(actor);
    return this.toView(actor, presence);
  }

  /**
   * The toggle.
   *
   * Requirement 3 is checked here, against the expert's *application status* —
   * not against a role, and not against anything the client sent. A SUSPENDED
   * expert who was AVAILABLE a second ago cannot go available again, and the
   * sweep below will already have taken them offline.
   */
  async setAvailability(actor: Actor, available: boolean): Promise<AvailabilityView> {
    authorize(actor, "expert_availability:update_own");
    const now = this.deps.clock.now();
    const presence = await this.requireOwnPresence(actor);
    const target: AvailabilityStatus = available ? "AVAILABLE" : "OFFLINE";

    if (available && !canGoAvailable(actor.expert?.status ?? "DRAFT")) {
      throw new ForbiddenError(
        "go available",
        `expert:${presence.expertProfileId} (status ${actor.expert?.status ?? "none"})`,
      );
    }

    if (presence.availabilityStatus === target) {
      // Idempotent: pressing the toggle twice is not an error, and a mobile
      // client retrying a request must not fail.
      return this.toView(actor, presence);
    }

    // An expert mid-offer or mid-session cannot toggle out of it — otherwise
    // going offline would be a way to dodge a request already sent to them.
    // Caught before the state machine so the message is something a human can
    // act on, rather than "Illegal state transition ON_OFFER → OFFLINE".
    if (presence.availabilityStatus === "ON_OFFER") {
      throw new ConflictError(
        "A request just came in and is waiting on your answer. Decline it and you will go offline straight after.",
        { availabilityStatus: presence.availabilityStatus },
      );
    }
    if (presence.availabilityStatus === "IN_SESSION") {
      throw new ConflictError(
        "You are in a session. You will go offline automatically when it ends.",
        { availabilityStatus: presence.availabilityStatus },
      );
    }

    assertAvailabilityTransition(presence.availabilityStatus, target, "MANUAL_TOGGLE");

    const updated = await this.deps.availability.changeStatus({
      expertProfileId: presence.expertProfileId,
      expectedStatus: presence.availabilityStatus,
      toStatus: target,
      source: "MANUAL_TOGGLE",
      now,
      changedByUserId: actor.userId,
    });

    if (!updated) {
      throw new ConflictError(
        "Your availability changed in another tab or was updated by the system. Reload and try again.",
      );
    }

    // Going available starts the presence clock immediately, so an expert is
    // matchable from the moment they flip the switch rather than 45 seconds
    // later when the first heartbeat lands.
    if (target === "AVAILABLE") {
      await this.deps.availability.touchHeartbeat(presence.expertProfileId, now);
      return this.toView(actor, {
        ...updated,
        lastHeartbeatAt: now,
      });
    }

    return this.toView(actor, updated);
  }

  /**
   * Presence ping.
   *
   * Requirement 5: this records a timestamp and **never** changes status. An
   * expert swept offline who leaves the tab open keeps sending heartbeats and
   * stays offline — because reappearing in the dispatch pool without saying so
   * is exactly the surprise the sticky rule exists to prevent.
   */
  async heartbeat(actor: Actor): Promise<AvailabilityView> {
    authorize(actor, "expert_availability:update_own");
    const presence = await this.requireOwnPresence(actor);

    const at = await this.deps.availability.touchHeartbeat(
      presence.expertProfileId,
      this.deps.clock.now(),
    );

    return this.toView(actor, { ...presence, lastHeartbeatAt: at });
  }

  async history(actor: Actor, limit = 50): Promise<readonly AvailabilityLogEntry[]> {
    authorize(actor, "expert_availability:read_own");
    const presence = await this.requireOwnPresence(actor);
    return this.deps.availability.listAvailabilityLog({
      expertProfileId: presence.expertProfileId,
      limit: Math.min(limit, 200),
    });
  }

  /**
   * Sweeps experts whose presence has gone stale.
   *
   * Called by the worker, with no actor: this is the system acting, and there is
   * deliberately no API surface for one expert to sweep another.
   *
   * Each sweep is guarded on the status it read, so a manual toggle racing the
   * sweep cannot be silently overwritten — the loser simply does nothing.
   */
  async sweepStalePresence(limit = 100): Promise<{ swept: number; skipped: number }> {
    const now = this.deps.clock.now();
    const staleBefore = new Date(now.getTime() - this.staleAfter * 1000);

    const stale = await this.deps.availability.findStalePresence({ staleBefore, limit });
    let swept = 0;
    let skipped = 0;

    for (const presence of stale) {
      const updated = await this.deps.availability.changeStatus({
        expertProfileId: presence.expertProfileId,
        expectedStatus: presence.availabilityStatus,
        toStatus: "OFFLINE",
        source: "HEARTBEAT_TIMEOUT",
        now,
        changedByUserId: null,
      });

      if (updated) {
        swept += 1;
        this.deps.logger.info("expert swept offline for stale presence", {
          expertProfileId: presence.expertProfileId,
          lastHeartbeatAt: presence.lastHeartbeatAt?.toISOString() ?? null,
          staleAfterSeconds: this.staleAfter,
        });
      } else {
        skipped += 1;
      }
    }

    return { swept, skipped };
  }

  private async requireOwnPresence(actor: Actor): Promise<ExpertPresenceRecord> {
    if (!actor.expert) throw new NotFoundError("ExpertProfile", `user:${actor.userId}`);
    const presence = await this.deps.availability.findPresence(actor.expert.profileId);
    if (!presence) throw new NotFoundError("ExpertProfile", actor.expert.profileId);
    // Ownership re-checked against the row, never taken from the request.
    if (presence.userId !== actor.userId) {
      throw new ForbiddenError("read availability", `expert:${presence.expertProfileId}`);
    }
    return presence;
  }

  private toView(actor: Actor, presence: ExpertPresenceRecord): AvailabilityView {
    const now = this.deps.clock.now();
    return {
      availabilityStatus: presence.availabilityStatus,
      lastHeartbeatAt: presence.lastHeartbeatAt,
      secondsSinceHeartbeat: secondsSinceHeartbeat(presence.lastHeartbeatAt, now),
      heartbeatStaleAfterSeconds: this.staleAfter,
      heartbeatIntervalSeconds: this.interval,
      eligibility: evaluateEligibility({
        expertStatus: actor.expert?.status ?? "DRAFT",
        accountStatus: actor.status,
        availabilityStatus: presence.availabilityStatus,
        lastHeartbeatAt: presence.lastHeartbeatAt,
        now,
        heartbeatStaleAfterSeconds: this.staleAfter,
      }),
    };
  }
}
