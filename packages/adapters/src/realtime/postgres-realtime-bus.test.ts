import { PrismaClient } from "@sfx/db";
import type { Logger } from "@sfx/domain";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_CHANNEL, PostgresRealtimeBus } from "./postgres-realtime-bus.js";

/**
 * That a published signal actually arrives.
 *
 * This suite exists because it did not, for the whole of Phase 6, and nothing
 * caught it.
 *
 * Both containers built the bus with `prisma.$queryRawUnsafe`. `pg_notify()`
 * returns `void`, and Prisma cannot deserialize a void column, so every publish
 * failed — 100% of the time, not intermittently — with "Failed to deserialize
 * column of type 'void'". `publish` then swallowed it, exactly as requirement 10
 * says it must: *a notification failure must never affect dispatch.* Dispatch
 * was indeed unaffected. Offers were created, expired on time, and appeared on
 * the next 15-second poll. The product worked, a little slower, and said so only
 * in a `warn` line nobody was reading.
 *
 * That is the lesson worth keeping: **a guarantee that degradation is safe is
 * also a guarantee that degradation is quiet.** The safety net was load-bearing
 * from day one and nobody knew, because the only evidence was an absence — no
 * signals, which looks identical to no activity.
 *
 * So this test asserts the thing every other test took on trust: publish to a
 * real Postgres, and a real `LISTEN` on another connection receives it. It
 * cannot be satisfied by a fake, and it fails loudly if the exec callback is
 * ever swapped back to a query executor.
 *
 * Gated exactly like `offer-concurrency.test.ts`: runs whenever a database is
 * configured, and `SKIP_DB_TESTS=1` (set by `pnpm verify --quick`) is the only
 * honest way out.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const SKIPPED = process.env.SKIP_DB_TESTS === "1";
const describeWithDb = DATABASE_URL && !SKIPPED ? describe : describe.skip;

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

describeWithDb("PostgresRealtimeBus against a real Postgres", () => {
  const prisma = new PrismaClient();
  let listener: Client;
  const received: string[] = [];

  beforeAll(async () => {
    listener = new Client({ connectionString: DATABASE_URL });
    await listener.connect();
    listener.on("notification", (message) => {
      if (message.payload) received.push(message.payload);
    });
    await listener.query(`LISTEN ${PG_CHANNEL}`);
  });

  afterAll(async () => {
    await listener.end().catch(() => undefined);
    await prisma.$disconnect();
  });

  /** Gives NOTIFY a moment to cross the connection, then reports what landed. */
  async function drain(): Promise<readonly string[]> {
    for (let attempt = 0; attempt < 40 && received.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return [...received];
  }

  it("delivers a published signal to a LISTEN on another connection", async () => {
    const bus = new PostgresRealtimeBus(
      (sql, params) => prisma.$executeRawUnsafe(sql, ...params),
      silentLogger,
    );

    await bus.publish(
      { kind: "expert", expertId: "expert-under-test" },
      { type: "offer.opened", payload: {}, occurredAt: new Date("2026-01-01T00:00:00.000Z") },
    );

    const payloads = await drain();
    expect(payloads).toHaveLength(1);

    const signal = JSON.parse(payloads[0] ?? "{}");
    expect(signal.channel).toBe("expert:expert-under-test");
    expect(signal.type).toBe("offer.opened");
    expect(signal.occurredAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("carries no state beyond a channel, a type and a timestamp", async () => {
    // Requirement 12, asserted on the actual bytes on the wire rather than on
    // the object we intended to send.
    const payloads = await drain();
    const signal = JSON.parse(payloads[0] ?? "{}");
    expect(Object.keys(signal).sort()).toEqual(["channel", "occurredAt", "type"]);
  });

  it("a query executor cannot publish at all — pg_notify returns void", async () => {
    /*
     * The regression itself, pinned. `$queryRawUnsafe` is what both containers
     * used, and this is what it does. If a future Prisma release makes the query
     * form work, this test fails and someone re-reads the class comment — which
     * is the correct outcome, because the comment would then be stale.
     */
    await expect(
      prisma.$queryRawUnsafe("SELECT pg_notify($1, $2)", PG_CHANNEL, "{}"),
    ).rejects.toThrow(/deserialize column of type 'void'/i);

    // And the command form, which is what the fix installs, succeeds.
    await expect(
      prisma.$executeRawUnsafe("SELECT pg_notify($1, $2)", PG_CHANNEL, "{}"),
    ).resolves.toBeDefined();
  });

  it("never throws upward, even when the executor fails (requirement 10)", async () => {
    const bus = new PostgresRealtimeBus(
      () => Promise.reject(new Error("connection lost")),
      silentLogger,
    );

    await expect(
      bus.publish(
        { kind: "customer", customerId: "customer-under-test" },
        { type: "request.state_changed", payload: {}, occurredAt: new Date() },
      ),
    ).resolves.toBeUndefined();
  });
});
