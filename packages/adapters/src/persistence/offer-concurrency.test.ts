import { PrismaClient } from "@sfx/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaMatchingRepository } from "./prisma-matching-repositories.js";

/**
 * Requirement 6, against a real Postgres.
 *
 * This is the one invariant in the product that **cannot** be tested with a
 * fake, because the thing being tested is a database object: the
 * `one_open_offer_per_expert` partial unique index. An application-level check
 * cannot provide it — two dispatchers can both read "no open offer" before
 * either writes one, and the loser would double-book a human being.
 *
 * The failure mode if this index were dropped is not an error. It is an expert
 * holding two live offers, accepting both, and two customers being told the same
 * person is theirs. That is why this test exists and why it talks to Postgres.
 *
 * Runs whenever a database is configured. `pnpm verify` guarantees one — the step
 * order was corrected in Phase 6 so this suite runs *after* Postgres is started
 * rather than before, which it had been doing and getting away with only because
 * the server usually happened to be up already.
 *
 * `SKIP_DB_TESTS=1` opts out, and `pnpm verify --quick` sets it. That flag exists
 * for the one case where skipping is honest — a mode that explicitly promises not
 * to touch a database — and nowhere else. A suite that quietly skips itself when
 * it cannot connect would be worse than one that fails: a gate omitting its most
 * important assertion reads exactly like a gate that passed.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const SKIPPED = process.env.SKIP_DB_TESTS === "1";
const describeWithDb = DATABASE_URL && !SKIPPED ? describe : describe.skip;

const prisma = new PrismaClient();
const STAMP = process.hrtime.bigint().toString(36).slice(-8);

/** Everything created here is namespaced and torn down in `afterAll`. */
const ids = {
  user: `cx-${STAMP}`,
  expertUser: `ex-${STAMP}`,
  customer: `cust-${STAMP}`,
  expert: `exp-${STAMP}`,
  requestA: `reqA-${STAMP}`,
  requestB: `reqB-${STAMP}`,
  runA: `runA-${STAMP}`,
  runB: `runB-${STAMP}`,
  attemptA: `attA-${STAMP}`,
  attemptB: `attB-${STAMP}`,
};

describeWithDb("one_open_offer_per_expert (requirement 6)", () => {
  let repo: PrismaMatchingRepository;

  beforeAll(async () => {
    repo = new PrismaMatchingRepository(prisma);

    const tier = await prisma.pricingTier.findFirst({ where: { isActive: true } });
    if (!tier) throw new Error("seed the database first: pnpm db:setup");

    await prisma.user.create({
      data: {
        id: ids.user,
        email: `${ids.user}@concurrency.test`,
        name: "Concurrency Customer",
        roles: ["CUSTOMER"],
        customer: { create: { id: ids.customer } },
      },
    });
    await prisma.user.create({
      data: {
        id: ids.expertUser,
        email: `${ids.expertUser}@concurrency.test`,
        name: "Concurrency Expert",
        roles: ["CUSTOMER", "EXPERT"],
        expert: {
          create: {
            id: ids.expert,
            status: "APPROVED",
            availabilityStatus: "AVAILABLE",
            lastHeartbeatAt: new Date(),
            country: "IN",
            timezone: "Asia/Kolkata",
            yearsExperience: 8,
            professionalSummary: "x".repeat(100),
          },
        },
      },
    });

    // Two customers' requests, both ranking the same expert first.
    for (const [requestId, runId, attemptId] of [
      [ids.requestA, ids.runA, ids.attemptA],
      [ids.requestB, ids.runB, ids.attemptB],
    ] as const) {
      await prisma.supportRequest.create({
        data: {
          id: requestId,
          customerId: ids.customer,
          title: "Apex governor limits",
          description: "Too many SOQL queries.",
          state: "SEARCHING",
          matchDeadlineAt: new Date(Date.now() + 15 * 60_000),
          pricingTierId: tier.id,
          quotedPriceCents: tier.priceCents,
          quotedPlatformFeeCents: 0,
          quotedExpertPayoutCents: tier.priceCents,
          matchingRuns: {
            create: {
              id: runId,
              roundNumber: 1,
              relaxationLevel: 0,
              weightsSnapshot: {},
              thresholdsSnapshot: {},
              candidatePoolSize: 1,
              attempts: {
                create: {
                  id: attemptId,
                  supportRequestId: requestId,
                  expertProfileId: ids.expert,
                  rank: 1,
                  status: "RANKED",
                },
              },
            },
          },
        },
      });
    }
  });

  afterAll(async () => {
    // Cascades from the requests and users clean up runs and attempts.
    await prisma.supportRequest
      .deleteMany({ where: { id: { in: [ids.requestA, ids.requestB] } } })
      .catch(() => undefined);
    await prisma.user
      .deleteMany({ where: { id: { in: [ids.user, ids.expertUser] } } })
      .catch(() => undefined);
    await prisma.$disconnect();
  });

  /**
   * Both attempts back to RANKED and the expert back to AVAILABLE.
   *
   * Every test calls this first. These tests share one expert row on a real
   * database, so without it each one inherits whatever the last race happened to
   * leave behind — and a test whose outcome depends on that is not testing the
   * invariant.
   */
  async function resetAttempts(): Promise<void> {
    await prisma.matchingAttempt.updateMany({
      where: { id: { in: [ids.attemptA, ids.attemptB] } },
      data: {
        status: "RANKED",
        origin: "ALGORITHMIC",
        offeredAt: null,
        offerExpiresAt: null,
        respondedAt: null,
        declineReason: null,
      },
    });
    await prisma.expertProfile.update({
      where: { id: ids.expert },
      data: { availabilityStatus: "AVAILABLE" },
    });
  }

  it("lets exactly one of two simultaneous offers through", async () => {
    await resetAttempts();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60_000);

    // Genuinely concurrent: both promises are in flight before either resolves.
    const results = await Promise.allSettled([
      repo.openOffer({
        attemptId: ids.attemptA,
        expertProfileId: ids.expert,
        now,
        offerExpiresAt: expiresAt,
      }),
      repo.openOffer({
        attemptId: ids.attemptB,
        expertProfileId: ids.expert,
        now,
        offerExpiresAt: expiresAt,
      }),
    ]);

    // One wrote the offer. The other either threw ConflictError (the index
    // rejected it) or returned null (it lost the availability guard) — both are
    // correct outcomes, and both are what the dispatcher handles by moving to
    // the next candidate.
    const winners = results.filter((r) => r.status === "fulfilled" && r.value !== null);
    expect(winners).toHaveLength(1);

    const open = await prisma.matchingAttempt.findMany({
      where: { expertProfileId: ids.expert, status: "OFFERED" },
    });
    expect(open).toHaveLength(1);
  });

  /**
   * Proves the *index* is load-bearing, not just the availability lock.
   *
   * The tests above go through `openOffer`, which also guards on
   * `availabilityStatus`. That guard serialises on the expert row, so it may
   * satisfy the assertion on its own and the index would never fire — a test
   * that passes for the wrong reason.
   *
   * This one writes both OFFERED rows directly, bypassing the service path
   * entirely, so the only thing that can reject the second write is the partial
   * unique index.
   *
   * **Verified by dropping it.** On a throwaway database with
   * `one_open_offer_per_expert` removed, this test fails and the other six still
   * pass — they were satisfied by the availability lock alone. So this is the
   * only test in the suite that actually holds the index to account, which is
   * exactly why it writes at the lowest level it can.
   */
  it("the partial unique index itself rejects a second open offer", async () => {
    // Self-contained: an earlier test may have left either attempt OFFERED, and
    // inheriting that state made this pass or fail depending on which one won a
    // race. Reset first, so the assertion is about the index and nothing else.
    await resetAttempts();

    await prisma.matchingAttempt.update({
      where: { id: ids.attemptA },
      data: { status: "OFFERED", offeredAt: new Date() },
    });

    await expect(
      prisma.matchingAttempt.update({
        where: { id: ids.attemptB },
        data: { status: "OFFERED", offeredAt: new Date() },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    // And a non-OFFERED second row is fine — the index is partial for a reason.
    await expect(
      prisma.matchingAttempt.update({
        where: { id: ids.attemptB },
        data: { status: "TIMED_OUT" },
      }),
    ).resolves.toBeTruthy();
  });

  it("holds under a wider stampede", async () => {
    await resetAttempts();

    const now = new Date();
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        repo.openOffer({
          attemptId: i % 2 === 0 ? ids.attemptA : ids.attemptB,
          expertProfileId: ids.expert,
          now,
          offerExpiresAt: new Date(now.getTime() + 60_000),
        }),
      ),
    );

    const winners = results.filter((r) => r.status === "fulfilled" && r.value !== null);
    expect(winners).toHaveLength(1);
    expect(
      await prisma.matchingAttempt.count({
        where: { expertProfileId: ids.expert, status: "OFFERED" },
      }),
    ).toBe(1);
  });

  it("frees the expert once the offer closes, and only then", async () => {
    await resetAttempts();
    const seedNow = new Date();
    await repo.openOffer({
      attemptId: ids.attemptA,
      expertProfileId: ids.expert,
      now: seedNow,
      offerExpiresAt: new Date(seedNow.getTime() + 60_000),
    });

    const openAttempt = await prisma.matchingAttempt.findFirst({
      where: { expertProfileId: ids.expert, status: "OFFERED" },
    });
    expect(openAttempt).not.toBeNull();

    // Still locked while the offer is open.
    expect(
      (await prisma.expertProfile.findUnique({ where: { id: ids.expert } }))?.availabilityStatus,
    ).toBe("ON_OFFER");

    await repo.closeOffer({
      attemptId: openAttempt!.id,
      expertProfileId: ids.expert,
      toStatus: "DECLINED",
      now: new Date(),
      countAgainstReliability: true,
      releaseTo: "AVAILABLE",
    });

    expect(
      await prisma.matchingAttempt.count({
        where: { expertProfileId: ids.expert, status: "OFFERED" },
      }),
    ).toBe(0);
    expect(
      (await prisma.expertProfile.findUnique({ where: { id: ids.expert } }))?.availabilityStatus,
    ).toBe("AVAILABLE");

    // And now a second offer is permitted — the index constrains *open* offers,
    // not historical ones.
    const now = new Date();
    const second = await repo.openOffer({
      attemptId: openAttempt!.id === ids.attemptA ? ids.attemptB : ids.attemptA,
      expertProfileId: ids.expert,
      now,
      offerExpiresAt: new Date(now.getTime() + 60_000),
    });
    expect(second?.status).toBe("OFFERED");
  });

  it("guards closeOffer so a decline racing a timeout produces one winner", async () => {
    await resetAttempts();
    const seedNow = new Date();
    await repo.openOffer({
      attemptId: ids.attemptA,
      expertProfileId: ids.expert,
      now: seedNow,
      offerExpiresAt: new Date(seedNow.getTime() + 60_000),
    });

    const open = await prisma.matchingAttempt.findFirst({
      where: { expertProfileId: ids.expert, status: "OFFERED" },
    });
    expect(open).not.toBeNull();

    const now = new Date();
    const [decline, timeout] = await Promise.all([
      repo.closeOffer({
        attemptId: open!.id,
        expertProfileId: ids.expert,
        toStatus: "DECLINED",
        now,
        countAgainstReliability: true,
        releaseTo: "AVAILABLE",
      }),
      repo.closeOffer({
        attemptId: open!.id,
        expertProfileId: ids.expert,
        toStatus: "TIMED_OUT",
        now,
        countAgainstReliability: true,
        releaseTo: "AVAILABLE",
      }),
    ]);

    const wrote = [decline, timeout].filter((result) => result !== null);
    expect(wrote).toHaveLength(1);
    // Whichever won, the row holds exactly one outcome — never both.
    const final = await prisma.matchingAttempt.findUnique({ where: { id: open!.id } });
    expect(["DECLINED", "TIMED_OUT"]).toContain(final?.status);
  });

  it("refuses to offer to an expert who is not AVAILABLE (requirement 14)", async () => {
    await resetAttempts();
    await prisma.expertProfile.update({
      where: { id: ids.expert },
      data: { availabilityStatus: "OFFLINE" },
    });

    const now = new Date();
    const result = await repo.openOffer({
      attemptId: ids.attemptA,
      expertProfileId: ids.expert,
      now,
      offerExpiresAt: new Date(now.getTime() + 60_000),
    });

    // Null, not an exception: "they went offline, try the next candidate" is an
    // ordinary outcome of a live bench, not an error.
    expect(result).toBeNull();
    expect((await prisma.matchingAttempt.findUnique({ where: { id: ids.attemptA } }))?.status).toBe(
      "RANKED",
    );
  });

  it("lets an admin force-assign reach an OFFLINE expert", async () => {
    // The dispatcher cannot; an operator who has already phoned them can.
    await resetAttempts();
    await prisma.matchingAttempt.update({
      where: { id: ids.attemptA },
      data: { origin: "ADMIN_FORCE_ASSIGN", rank: null, adminReason: "reached out-of-band" },
    });
    await prisma.expertProfile.update({
      where: { id: ids.expert },
      data: { availabilityStatus: "OFFLINE" },
    });

    const now = new Date();
    const result = await repo.openOffer({
      attemptId: ids.attemptA,
      expertProfileId: ids.expert,
      now,
      offerExpiresAt: new Date(now.getTime() + 60_000),
    });
    expect(result?.status).toBe("OFFERED");
    expect(
      (await prisma.expertProfile.findUnique({ where: { id: ids.expert } }))?.availabilityStatus,
    ).toBe("ON_OFFER");
  });
});
