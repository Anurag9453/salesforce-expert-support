import { authorize, type Actor } from "../authorization/index.js";
import type { Clock } from "../ports/clock.js";
import type { Logger } from "../ports/logger.js";
import type {
  NotificationRecord,
  NotificationRepository,
} from "../ports/notification-repository.js";

/**
 * In-app notifications — the bell.
 *
 * ## Why these are stored when realtime already exists
 *
 * Realtime is a doorbell: it says "something changed", carries no state, and is
 * gone the moment it is delivered. That is the right design for a live dashboard
 * and useless for "what did I miss?". An expert who closed their laptop for an
 * hour has no way to learn that three requests came and went.
 *
 * So these are the durable record and realtime is the nudge that makes the bell
 * update without a refresh. The two are not alternatives.
 *
 * ## What may go in one
 *
 * The same rule as the realtime payload and the browser notification: a title
 * and a link, never the substance. No customer problem text, no scores, no ranks,
 * no other expert's identity. A notification is read on a lock screen, over
 * someone's shoulder, in a screen share — treat it as public.
 *
 * `record` therefore takes a narrow, pre-composed message rather than a payload
 * to interpolate. If a caller wants to say more, the answer is that the customer
 * opens the request.
 */

export const NOTIFICATION_EVENTS = {
  OFFER_RECEIVED: "offer.received",
  OFFER_MISSED: "offer.missed",
  REQUEST_MATCHED: "request.matched",
  REQUEST_NO_EXPERT: "request.no_expert",
  SHORTLIST_READY: "shortlist.ready",
  SELECTED_BY_CUSTOMER: "shortlist.selected",
  PAYMENT_DUE: "payment.due",
  SESSION_READY: "session.ready",
  SESSION_CUSTOMER_JOINED: "session.customer_joined",
  APPLICATION_DECIDED: "application.decided",
} as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[keyof typeof NOTIFICATION_EVENTS];

export interface NotificationServiceDeps {
  readonly notifications: NotificationRepository;
  readonly clock: Clock;
  readonly logger: Logger;
}

export class NotificationService {
  constructor(private readonly deps: NotificationServiceDeps) {}

  /**
   * The caller's own notifications, newest first.
   *
   * Scoped to the actor's own user id rather than taking one as a parameter —
   * there is no "read someone else's notifications" operation to get wrong.
   */
  async listMine(
    actor: Actor,
    options: { limit?: number } = {},
  ): Promise<{ items: readonly NotificationRecord[]; unread: number }> {
    authorize(actor, "account:read_self");
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
    const [items, unread] = await Promise.all([
      this.deps.notifications.listForUser({ userId: actor.userId, limit }),
      this.deps.notifications.countUnread(actor.userId),
    ]);
    return { items, unread };
  }

  /**
   * Marks everything currently unread as read.
   *
   * All-or-nothing rather than per-item: the bell's job is to stop drawing
   * attention once it has been looked at, and per-item read state invites a UI
   * where the badge and the list disagree.
   */
  async markAllRead(actor: Actor): Promise<{ updated: number }> {
    authorize(actor, "account:read_self");
    const updated = await this.deps.notifications.markAllRead({
      userId: actor.userId,
      readAt: this.deps.clock.now(),
    });
    return { updated };
  }

  /**
   * Records one, and never lets the attempt break its caller.
   *
   * Same discipline as the realtime bus (requirement 10): a notification is a
   * courtesy layered on top of a durable state change that has already happened.
   * If writing it fails, the offer still exists and the dashboard still shows it.
   * Failing dispatch to deliver a bell icon would be precisely the wrong trade.
   */
  async record(input: {
    readonly userId: string;
    readonly event: NotificationEvent;
    readonly title: string;
    readonly body?: string;
    readonly href?: string;
  }): Promise<void> {
    try {
      await this.deps.notifications.create({
        userId: input.userId,
        eventType: input.event,
        channel: "IN_APP",
        payload: {
          title: input.title,
          ...(input.body ? { body: input.body } : {}),
          ...(input.href ? { href: input.href } : {}),
        },
        createdAt: this.deps.clock.now(),
      });
    } catch (error) {
      this.deps.logger.warn("in-app notification not recorded; the state change stands", {
        userId: input.userId,
        event: input.event,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** As `record`, for an expert. Swallows failures for the same reason. */
  async recordForExpert(input: {
    readonly expertProfileId: string;
    readonly event: NotificationEvent;
    readonly title: string;
    readonly body?: string;
    readonly href?: string;
  }): Promise<void> {
    try {
      await this.deps.notifications.createForExpertProfile({
        expertProfileId: input.expertProfileId,
        eventType: input.event,
        payload: {
          title: input.title,
          ...(input.body ? { body: input.body } : {}),
          ...(input.href ? { href: input.href } : {}),
        },
        createdAt: this.deps.clock.now(),
      });
    } catch (error) {
      this.deps.logger.warn("in-app notification not recorded; the state change stands", {
        expertProfileId: input.expertProfileId,
        event: input.event,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** As `record`, for a customer. */
  async recordForCustomer(input: {
    readonly customerProfileId: string;
    readonly event: NotificationEvent;
    readonly title: string;
    readonly body?: string;
    readonly href?: string;
  }): Promise<void> {
    try {
      await this.deps.notifications.createForCustomerProfile({
        customerProfileId: input.customerProfileId,
        eventType: input.event,
        payload: {
          title: input.title,
          ...(input.body ? { body: input.body } : {}),
          ...(input.href ? { href: input.href } : {}),
        },
        createdAt: this.deps.clock.now(),
      });
    } catch (error) {
      this.deps.logger.warn("in-app notification not recorded; the state change stands", {
        customerProfileId: input.customerProfileId,
        event: input.event,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
