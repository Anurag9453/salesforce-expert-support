/**
 * Durable in-app notifications.
 *
 * A separate port from `Mailer` and `PushSender` on purpose: those are transports
 * that fire and forget, this is a record the user can come back to. Folding them
 * together would mean an inbox whose contents depend on whether an email
 * provider happened to be reachable.
 */

export interface NotificationRecord {
  readonly id: string;
  readonly eventType: string;
  readonly title: string;
  readonly body: string | null;
  readonly href: string | null;
  readonly readAt: Date | null;
  readonly createdAt: Date;
}

export interface NotificationRepository {
  create(input: {
    readonly userId: string;
    readonly eventType: string;
    readonly channel: "IN_APP" | "EMAIL" | "PUSH" | "SMS";
    readonly payload: Readonly<Record<string, unknown>>;
    readonly createdAt: Date;
  }): Promise<void>;

  listForUser(params: {
    readonly userId: string;
    readonly limit: number;
  }): Promise<readonly NotificationRecord[]>;

  /**
   * Dispatch works in profile ids; notifications belong to users. Resolving that
   * here rather than plumbing a user id through five dispatch call sites keeps
   * the notifier's signatures about dispatch, and costs one indexed lookup on a
   * path that is already best-effort.
   *
   * A no-op when the profile does not exist — a notification is never worth
   * failing over.
   */
  createForExpertProfile(input: {
    readonly expertProfileId: string;
    readonly eventType: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly createdAt: Date;
  }): Promise<void>;

  createForCustomerProfile(input: {
    readonly customerProfileId: string;
    readonly eventType: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly createdAt: Date;
  }): Promise<void>;

  countUnread(userId: string): Promise<number>;

  /** Returns how many rows changed, so the caller can tell a no-op from work. */
  markAllRead(params: { readonly userId: string; readonly readAt: Date }): Promise<number>;
}
