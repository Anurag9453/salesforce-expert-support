import type { Logger, RealtimeBus, RealtimeChannel, RealtimeEvent } from "@sfx/domain";
import { Client } from "pg";

/**
 * Realtime over Postgres `LISTEN`/`NOTIFY` (§17).
 *
 * Chosen over a hosted service for V1 for one reason that matters more than any
 * technical comparison: **it works with no signup, no API key, and no second
 * failure domain.** The whole dispatch loop can be demonstrated and tested by
 * anyone who can run the app, and there is no third party whose outage becomes
 * our outage.
 *
 * It is also, importantly, *not* the source of truth. Every screen fed by these
 * signals derives its state from a plain authenticated GET, so a dropped or
 * duplicated message costs latency and nothing else (requirements 1, 2, 10).
 * That is what makes a modest transport an acceptable one.
 *
 * ## The shape of a signal
 *
 * A signal says **"something changed on this channel"** and carries no state
 * (requirement 3). The client's response is always to re-fetch. Three
 * consequences, each one a requirement satisfied by construction rather than by
 * care:
 *
 *   - **Idempotent** — replaying a signal re-runs a GET, which returns the same
 *     authoritative answer. There is no payload to apply twice (requirement 2).
 *   - **Nothing sensitive on the wire** — no scores, no ranks, no other
 *     expert's identity, no customer text (requirement 12). The payload is a
 *     type and a timestamp.
 *   - **Out-of-order delivery is harmless** — a late signal triggers a fetch
 *     that returns *current* state, not the state the signal described.
 *
 * ## Deployment caveat
 *
 * `LISTEN` needs a long-lived connection, which a serverless function cannot
 * hold. The web app must run on a platform that keeps a process alive (a
 * container, a VM, Node on Fly/Render) — or the `RealtimeBus` port gets a hosted
 * adapter, which is exactly why it is a port. Recorded in the Phase 6 TODOs.
 */

/**
 * One Postgres channel for everything, with the logical channel in the payload.
 *
 * Not per-expert `LISTEN`s: those are identifiers capped at 63 bytes and would
 * mean a `LISTEN` statement per subscriber per connection, which does not scale
 * and cannot be un-listened cleanly. One channel plus server-side filtering is
 * simpler and — because the filtering happens where authorization already lives
 * — safer.
 */
const PG_CHANNEL = "sfx_realtime";

export interface RealtimeSignal {
  /** Serialised channel, e.g. `expert:abc123`. */
  readonly channel: string;
  readonly type: string;
  readonly occurredAt: string;
  /** So it can be handed straight to a structured logger. */
  readonly [key: string]: string;
}

export function serialiseChannel(channel: RealtimeChannel): string {
  switch (channel.kind) {
    case "expert":
      return `expert:${channel.expertId}`;
    case "customer":
      return `customer:${channel.customerId}`;
    case "request":
      return `request:${channel.requestId}`;
    case "session":
      return `session:${channel.sessionId}`;
    case "admin":
      return "admin";
    default: {
      const never: never = channel;
      throw new Error(`Unhandled channel: ${String(never)}`);
    }
  }
}

// ── Publisher ────────────────────────────────────────────────────────────────

/**
 * Publishes with `pg_notify` through the ordinary Prisma connection.
 *
 * Deliberately fire-and-forget from the caller's perspective: `publish` never
 * throws upward. Requirement 10 — a notification failure must not affect
 * dispatch. The offer is already committed; if the signal is lost, the expert
 * sees it on their next poll or reload, which is a slower path to the same
 * outcome rather than a broken one.
 */
export class PostgresRealtimeBus implements RealtimeBus {
  readonly name = "postgres";

  constructor(
    private readonly exec: (sql: string, params: readonly unknown[]) => Promise<unknown>,
    private readonly logger: Logger,
  ) {}

  async publish(channel: RealtimeChannel, event: RealtimeEvent): Promise<void> {
    const signal: RealtimeSignal = {
      channel: serialiseChannel(channel),
      type: event.type,
      occurredAt: event.occurredAt.toISOString(),
    };
    try {
      await this.exec("SELECT pg_notify($1, $2)", [PG_CHANNEL, JSON.stringify(signal)]);
      this.logger.debug("realtime signal published", signal);
    } catch (error) {
      // Never rethrow. See the class comment: dispatch does not depend on this.
      this.logger.warn("realtime publish failed; dispatch is unaffected", {
        ...signal,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * No token to issue.
   *
   * The browser never names a channel: it opens an SSE stream and the *server*
   * decides what it will receive, from the session. That removes the entire
   * class of bug where a client asks for a channel it should not have
   * (requirement 11) — there is no channel name in the request to tamper with.
   */
  async issueClientToken(): Promise<string> {
    return "";
  }
}

// ── Subscriber ───────────────────────────────────────────────────────────────

type Subscriber = (signal: RealtimeSignal) => void;

/**
 * One `LISTEN` connection per process, fanned out in memory.
 *
 * A connection per SSE client would exhaust the pool at a few dozen experts.
 * This holds exactly one, reconnects with backoff if it drops, and delivers to
 * every local subscriber.
 *
 * A dropped connection means missed signals, which is why the client also
 * reconciles on reconnect (requirement 14) — the hub does not try to replay,
 * because replaying a signal whose only content is "something changed" is
 * indistinguishable from sending a fresh one.
 */
export class PostgresRealtimeHub {
  private client: Client | null = null;
  private readonly subscribers = new Set<Subscriber>();
  private connecting: Promise<void> | null = null;
  private closed = false;
  private backoffMs = 500;

  constructor(
    private readonly connectionString: string,
    private readonly logger: Logger,
  ) {}

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    void this.ensureConnected();
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  private async ensureConnected(): Promise<void> {
    if (this.client || this.closed) return;
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    const client = new Client({ connectionString: this.connectionString });

    client.on("notification", (message) => {
      if (message.channel !== PG_CHANNEL || !message.payload) return;
      let signal: RealtimeSignal;
      try {
        signal = JSON.parse(message.payload) as RealtimeSignal;
      } catch {
        this.logger.warn("realtime signal was not valid JSON", { payload: message.payload });
        return;
      }
      for (const subscriber of this.subscribers) {
        try {
          subscriber(signal);
        } catch (error) {
          // One broken subscriber must not stop the others.
          this.logger.warn("realtime subscriber threw", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });

    client.on("error", (error: Error) => {
      this.logger.warn("realtime listen connection error; will reconnect", {
        error: error.message,
      });
      this.client = null;
      void client.end().catch(() => undefined);
      this.scheduleReconnect();
    });

    try {
      await client.connect();
      await client.query(`LISTEN ${PG_CHANNEL}`);
      this.client = client;
      this.backoffMs = 500;
      this.logger.info("realtime listening", { channel: PG_CHANNEL });
    } catch (error) {
      this.logger.warn("realtime listen failed; will retry", {
        error: error instanceof Error ? error.message : String(error),
      });
      await client.end().catch(() => undefined);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.subscribers.size === 0) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 10_000);
    const timer = setTimeout(() => void this.ensureConnected(), delay);
    timer.unref?.();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.subscribers.clear();
    const client = this.client;
    this.client = null;
    await client?.end().catch(() => undefined);
  }
}

/**
 * A bus that does nothing, for tests and for a deployment with realtime off.
 *
 * Requirement 10 as a runnable configuration: with this installed, every offer
 * is still created, still expires on time, and is still visible on the
 * dashboard. Only the immediacy is lost.
 */
export class NoopRealtimeBus implements RealtimeBus {
  readonly name = "noop";
  readonly published: Array<{ channel: string; type: string }> = [];

  async publish(channel: RealtimeChannel, event: RealtimeEvent): Promise<void> {
    this.published.push({ channel: serialiseChannel(channel), type: event.type });
  }

  async issueClientToken(): Promise<string> {
    return "";
  }
}
