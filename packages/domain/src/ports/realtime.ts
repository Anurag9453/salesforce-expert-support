/**
 * Realtime delivery (§17).
 *
 * A delivery optimisation, never a source of truth. Every screen fed by these
 * events can also derive its state from a plain GET, so a dropped message costs
 * latency and nothing else. Dispatch correctness lives in Postgres.
 */
export type RealtimeChannel =
  | { readonly kind: "expert"; readonly expertId: string }
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
