import type { Clock } from "../ports/clock.js";
import type { Logger } from "../ports/logger.js";
import type { RealtimeBus } from "../ports/realtime.js";
import {
  NOTIFICATION_EVENTS,
  type NotificationService,
} from "../notifications/notification-service.js";

/**
 * The realtime signals the dispatch loop emits (§17, requirements 1–3, 12).
 *
 * Every one of these is a **doorbell, not a delivery**. The payload is a type and
 * a timestamp; the client's only correct response is to re-fetch the
 * authoritative state from an authenticated endpoint. That single decision
 * satisfies four of the phase's requirements at once, and it does so structurally
 * rather than by anyone remembering to be careful:
 *
 *   - **1 — never the source of truth.** There is no state in the message, so
 *     there is nothing a client could mistake for truth.
 *   - **2 — idempotent.** Replaying "something changed" re-runs a GET. Applying
 *     it twice and applying it once are the same operation.
 *   - **3 — reconcile, don't trust.** Not a policy the client is asked to follow;
 *     the message contains nothing else it could do.
 *   - **12 — nothing sensitive.** No scores, no ranks, no other expert's
 *     identity, no customer text. There is no field for them.
 *
 * Requirement 15 falls out too: the countdown a client renders comes from
 * `offerExpiresAt` on the fetched offer, so a signal — however often it arrives —
 * cannot reset or extend the window.
 */

export const DISPATCH_EVENTS = {
  /** An offer is open for you. Fetch `/api/v1/expert/offer`. */
  OFFER_OPENED: "offer.opened",
  /** Your offer is no longer open — accepted, declined, timed out, withdrawn. */
  OFFER_CLOSED: "offer.closed",
  /** This request's state moved. Fetch `/api/v1/requests/:id`. */
  REQUEST_STATE_CHANGED: "request.state_changed",
} as const;

export type DispatchEventType = (typeof DISPATCH_EVENTS)[keyof typeof DISPATCH_EVENTS];

/**
 * The eight timing points requirement 16 asks for.
 *
 * Logged as structured events on one line each with `latency` in the name, so
 * the Phase 6 assessment can answer "where does the perceived delay actually
 * sit" by grepping rather than by guessing. The first six are server-side; the
 * last two are reported by the browser to `/api/v1/telemetry/timing`, because
 * only the client knows when a human could actually see something.
 */
export const TIMING_POINTS = {
  REQUEST_SUBMITTED: "request_submitted",
  CLASSIFICATION_COMPLETED: "classification_completed",
  MATCHING_RUN_STARTED: "matching_run_started",
  OFFER_PERSISTED: "offer_persisted",
  REALTIME_PUBLISHED: "realtime_published",
  EXPERT_RECONCILED: "expert_reconciled",
  EXPERT_ACCEPTED: "expert_accepted",
  CUSTOMER_RECONCILED: "customer_reconciled",
} as const;

export type TimingPoint = (typeof TIMING_POINTS)[keyof typeof TIMING_POINTS];

/**
 * One place that decides what a timing line looks like.
 *
 * Used by the request service and the classify job as well as by the notifier,
 * because requirement 16's eight points span three modules and a format defined
 * in three places is a format that cannot be grepped.
 */
export function logTiming(
  logger: Logger,
  point: TimingPoint,
  fields: Record<string, unknown>,
): void {
  logger.info(`latency ${point}`, { timingPoint: point, ...fields });
}

export interface DispatchNotifierDeps {
  readonly realtime: RealtimeBus;
  readonly clock: Clock;
  readonly logger: Logger;
  /**
   * Optional in-app notifications — the bell.
   *
   * Optional because realtime and the bell answer different questions and
   * neither is required for dispatch to be correct: realtime is "something just
   * happened", the bell is "what did I miss?". A deployment can run without the
   * second and lose nothing durable.
   */
  readonly notifications?: NotificationService;
}

/**
 * Publishes dispatch signals and records timing.
 *
 * Every method swallows its own failures. Requirement 10 is not "handle the
 * error" — it is that the durable offer is unaffected, and the way to guarantee
 * that is for this class to be incapable of failing a caller. A lost signal
 * degrades the experience to the Phase 5 one: the expert sees the offer when they
 * open the dashboard.
 */
export class DispatchNotifier {
  constructor(private readonly deps: DispatchNotifierDeps) {}

  /**
   * An offer opened for an expert, and the request moved to OFFERED.
   *
   * Two channels, because two different people need to know two different
   * things: the expert that they have work, the customer that someone is looking
   * at it. Neither message says anything about the other party.
   */
  async offerOpened(params: {
    readonly expertProfileId: string;
    readonly supportRequestId: string;
    readonly customerId: string;
    readonly offeredAt: Date;
  }): Promise<void> {
    const now = this.deps.clock.now();
    await this.publish(
      { kind: "expert", expertId: params.expertProfileId },
      DISPATCH_EVENTS.OFFER_OPENED,
    );
    await this.notifyRequestChanged(params.supportRequestId, params.customerId);

    /*
      The durable counterpart to the doorbell above. Says that work arrived and
      where to go, and nothing about what the work is — a notification is read on
      a lock screen and over shoulders, so it gets the same treatment as the
      realtime payload and the browser notification: no customer text, no score,
      no other expert.
    */
    await this.deps.notifications?.recordForExpert({
      expertProfileId: params.expertProfileId,
      event: NOTIFICATION_EVENTS.OFFER_RECEIVED,
      title: "A new request was matched to you",
      body: "Open it to accept or decline.",
      // The request itself, not the workspace. By the time an expert opens a
      // notification the workspace may be showing a different offer, or none —
      // so linking there means the one thing the notification was about is the
      // one thing they cannot see.
      href: `/expert/request/${params.supportRequestId}`,
    });

    this.timing(TIMING_POINTS.REALTIME_PUBLISHED, {
      supportRequestId: params.supportRequestId,
      // How long between the offer row committing and the doorbell ringing.
      // If perceived latency is bad and this number is small, the delay is in
      // the browser, not in us.
      sincePersistedMs: now.getTime() - params.offeredAt.getTime(),
    });
  }

  /** An offer closed, for whatever reason. The expert's card should go away. */
  async offerClosed(params: {
    readonly expertProfileId: string;
    readonly supportRequestId: string;
    readonly customerId: string;
  }): Promise<void> {
    await this.publish(
      { kind: "expert", expertId: params.expertProfileId },
      DISPATCH_EVENTS.OFFER_CLOSED,
    );
    await this.notifyRequestChanged(params.supportRequestId, params.customerId);
  }

  /** The request's state moved without an offer changing hands. */
  async requestStateChanged(supportRequestId: string, customerId: string): Promise<void> {
    await this.notifyRequestChanged(supportRequestId, customerId);
  }

  /**
   * Both channels, every time.
   *
   * `customer:<id>` is what the customer's own screen listens on — stable for the
   * life of their session, so it cannot go stale when they submit a new request.
   * `request:<id>` is for the admin and, later, the session view, where the
   * subject really is one specific request.
   */
  private async notifyRequestChanged(supportRequestId: string, customerId: string): Promise<void> {
    await this.publish({ kind: "customer", customerId }, DISPATCH_EVENTS.REQUEST_STATE_CHANGED);
    await this.publish(
      { kind: "request", requestId: supportRequestId },
      DISPATCH_EVENTS.REQUEST_STATE_CHANGED,
    );
  }

  /** One structured line per timing point (requirement 16). */
  timing(point: TimingPoint, fields: Record<string, unknown>): void {
    logTiming(this.deps.logger, point, fields);
  }

  private async publish(
    channel: Parameters<RealtimeBus["publish"]>[0],
    type: DispatchEventType,
  ): Promise<void> {
    try {
      await this.deps.realtime.publish(channel, {
        type,
        // Empty, always. See the module comment — the absence of a payload is
        // the mechanism, not an omission.
        payload: {},
        occurredAt: this.deps.clock.now(),
      });
    } catch (error) {
      this.deps.logger.warn("realtime publish failed; dispatch is unaffected", {
        type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
