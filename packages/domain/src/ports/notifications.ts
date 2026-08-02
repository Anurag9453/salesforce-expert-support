/**
 * §18 — notification delivery behind an abstraction from day one, so provider
 * logic never leaks into a business service.
 */
export type NotificationEventType =
  | "SUPPORT_REQUEST_RECEIVED"
  | "EXPERT_OFFER"
  | "EXPERT_ACCEPTED"
  | "SESSION_STARTING"
  | "SESSION_COMPLETED"
  | "PAYMENT_SUCCESS"
  | "PAYMENT_FAILED"
  | "NO_EXPERT_FOUND"
  | "EXPERT_APPLICATION_APPROVED"
  | "EXPERT_APPLICATION_REJECTED"
  | "EXPERT_SWEPT_OFFLINE";

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly idempotencyKey?: string;
}

export interface Mailer {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

export interface PushMessage {
  readonly title: string;
  readonly body: string;
  readonly url?: string;
  /** Collapses an offer notification so a stale one cannot linger. */
  readonly tag?: string;
  readonly requireInteraction?: boolean;
}

export interface PushSender {
  readonly name: string;
  sendToUser(userId: string, message: PushMessage): Promise<void>;
}
