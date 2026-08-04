/**
 * Realtime delivery (§17).
 *
 * A delivery optimisation, never a source of truth. Every screen fed by these
 * events can also derive its state from a plain GET, so a dropped message costs
 * latency and nothing else. Dispatch correctness lives in Postgres.
 */
/**
 * Channels are keyed on **identity**, not on the thing being talked about.
 *
 * `customer:<profileId>` rather than only `request:<id>` because a subscriber's
 * entitlements have to be computable once, from the session, and stay true. A
 * per-request channel list is computed from rows that change: a customer who
 * opens the dashboard and then submits a request — client-side navigation, one
 * long-lived stream — would be subscribed to a set that no longer describes them,
 * and would sit watching a spinner while their request was already matched.
 *
 * `request:<id>` is kept for the admin and session views, where the subject is
 * genuinely a specific request rather than "whatever is mine".
 */
export type RealtimeChannel =
  | { readonly kind: "expert"; readonly expertId: string }
  | { readonly kind: "customer"; readonly customerId: string }
  | { readonly kind: "request"; readonly requestId: string }
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "admin" };

export interface RealtimeEvent {
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
}

export interface RealtimeBus {
  readonly name: string;
  publish(channel: RealtimeChannel, event: RealtimeEvent): Promise<void>;
  /** Short-lived, channel-scoped token for a browser or mobile client. */
  issueClientToken(userId: string, channels: readonly RealtimeChannel[]): Promise<string>;
}
