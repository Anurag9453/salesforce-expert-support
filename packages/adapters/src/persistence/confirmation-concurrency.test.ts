import { PrismaClient } from "@sfx/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaMatchingRepository } from "./prisma-matching-repositories.js";

/**
 * `one_confirming_per_request`, against a real Postgres.
 *
 * The companion to the `one_open_offer_per_expert` suite, and it exists because
 * the interest-pool flow has the *mirror image* of that invariant. There the
 * risk is one expert holding two offers; here it is one request asking two
 * experts to confirm.
 *
 * The application check — "refuse to select while something is CONFIRMING" —
 * cannot provide it, and the reason is worth being precise about, because it is
 * the reason the bug survived a passing unit test: two selections naming
 * *different* attempts each satisfy their own `status = 'SHORTLISTED'`
 * precondition. Neither UPDATE is wrong on its own. Only a constraint spanning
 * the request can see that together they are.
 *
 * The failure mode if this index were dropped is, again, not an error: two
 * experts are asked to confirm, both can accept, and the customer watching a
 * single countdown gets whichever one the race happened to favour.
 *
 * Same environment contract as the offer suite — runs whenever `DATABASE_URL` is
 * set, opts out only under the `--quick` flag that explicitly promises not to
 * touch a database.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const SKIPPED = process.env.SKIP_DB_TESTS === "1";
const describeWithDb = DATABASE_URL && !SKIPPED ? describe : describe.skip;

const prisma = new PrismaClient();
const STAMP = process.hrtime.bigint().toString(36).slice(-8);

const ids = {
  user: `ccx-${STAMP}`,
  customer: `ccust-${STAMP}`,
  expertUserA: `cexA-${STAMP}`,
  expertUserB: `cexB-${STAMP}`,
  expertA: `cexpA-${STAMP}`,
  expertB: `cexpB-${STAMP}`,
  request: `creq-${STAMP}`,
  run: `crun-${STAMP}`,
  attemptA: `cattA-${STAMP}`,
  attemptB: `cattB-${STAMP}`,
};

describeWithDb("one_confirming_per_request", () => {
  let repo: PrismaMatchingRepository;

  beforeAll(async () => {
    repo = new PrismaMatchingRepository(prisma);

    const tier = await prisma.pricingTier.findFirst({ where: { isActive: true } });
    if (!tier) throw new Error("seed the database first: pnpm db:setup");

    await prisma.user.create({
      data: {
        id: ids.user,
        email: `${ids.user}@confirmation.test`,
        name: "Confirmation Customer",
        roles: ["CUSTOMER"],
        customer: { create: { id: ids.customer } },
      },
    });

    // Two experts, because this invariant is about one request reaching two
    // people — the opposite shape from the offer suite's one expert, two
    // requests.
    for (const [userId, profileId, label] of [
      [ids.expertUserA, ids.expertA, "A"],
      [ids.expertUserB, ids.expertB, "B"],
    ] as const) {
      await prisma.user.create({
        data: {
          id: userId,
          email: `${userId}@confirmation.test`,
          name: `Confirmation Expert ${label}`,
          roles: ["CUSTOMER", "EXPERT"],
          expert: {
            create: {
              id: profileId,
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
    }

    await prisma.supportRequest.create({
      data: {
        id: ids.request,
        customerId: ids.customer,
        title: "Flow fails on bulk update",
        description: "A record-triggered flow hits a limit at 200 records.",
        state: "SEARCHING",
        matchDeadlineAt: new Date(Date.now() + 15 * 60_000),
        pricingTierId: tier.id,
        quotedPriceCents: tier.priceCents,
        quotedPlatformFeeCents: 0,
        quotedExpertPayoutCents: tier.priceCents,
        matchingRuns: {
          create: {
            id: ids.run,
            roundNumber: 1,
            relaxationLevel: 0,
            weightsSnapshot: {},
            thresholdsSnapshot: {},
            candidatePoolSize: 2,
            attempts: {
              create: [
                {
                  id: ids.attemptA,
                  supportRequestId: ids.request,
                  expertProfileId: ids.expertA,
                  rank: 1,
                  status: "RANKED",
                },
                {
                  id: ids.attemptB,
                  supportRequestId: ids.request,
                  expertProfileId: ids.expertB,
                  rank: 2,
                  status: "RANKED",
                },
              ],
            },
          },
        },
      },
    });
  });

  afterAll(async () => {
    await prisma.supportRequest.deleteMany({ where: { id: ids.request } }).catch(() => undefined);
    await prisma.user
      .deleteMany({ where: { id: { in: [ids.user, ids.expertUserA, ids.expertUserB] } } })
      .catch(() => undefined);
    await prisma.$disconnect();
  });

  /** Both candidates back to SHORTLISTED, so no test inherits a prior race. */
  async function resetShortlist(): Promise<void> {
    await prisma.matchingAttempt.updateMany({
      where: { id: { in: [ids.attemptA, ids.attemptB] } },
      data: {
        status: "SHORTLISTED",
        offeredAt: null,
        offerExpiresAt: null,
        respondedAt: null,
        declineReason: null,
      },
    });
  }

  it("lets exactly one of two simultaneous selections open a window", async () => {
    await resetShortlist();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 120_000);

    // The exact race a customer produces by clicking two cards quickly, or by a
    // double-submitted form: two *different* attempts, both legally SHORTLISTED.
    const results = await Promise.allSettled([
      repo.startConfirmation({
        attemptId: ids.attemptA,
        expertProfileId: ids.expertA,
        expiresAt,
        now,
      }),
      repo.startConfirmation({
        attemptId: ids.attemptB,
        expertProfileId: ids.expertB,
        expiresAt,
        now,
      }),
    ]);

    // The loser must come back as null, not as a thrown P2002. That is the
    // assertion that proves the adapter recognises *this* index by name — a
    // constraint-matching bug would surface here as a rejection.
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);
    const winners = results.filter((r) => r.status === "fulfilled" && r.value !== null);
    expect(winners).toHaveLength(1);

    const confirming = await prisma.matchingAttempt.findMany({
      where: { supportRequestId: ids.request, status: "CONFIRMING" },
    });
    expect(confirming).toHaveLength(1);
  });

  /**
   * Proves the *index* is load-bearing rather than the SHORTLISTED guard.
   *
   * The test above goes through `startConfirmation`, whose status precondition
   * might satisfy the assertion on its own under a lucky interleaving — a test
   * that passes for the wrong reason. This one writes both CONFIRMING rows
   * directly, so the only thing left that can reject the second is the index.
   */
  it("the partial unique index itself rejects a second confirmation", async () => {
    await resetShortlist();

    await prisma.matchingAttempt.update({
      where: { id: ids.attemptA },
      data: { status: "CONFIRMING", offeredAt: new Date() },
    });

    await expect(
      prisma.matchingAttempt.update({
        where: { id: ids.attemptB },
        data: { status: "CONFIRMING", offeredAt: new Date() },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    // Partial for a reason: any number of non-CONFIRMING siblings are fine.
    await expect(
      prisma.matchingAttempt.update({
        where: { id: ids.attemptB },
        data: { status: "TIMED_OUT" },
      }),
    ).resolves.toBeTruthy();
  });

  /**
   * The lapse-then-retry path, which the index must NOT block.
   *
   * An expert letting their window lapse is the common case, and the customer
   * immediately picking someone else has to work. If the index were written
   * without its `WHERE status = 'CONFIRMING'` clause this would fail, so it is
   * the test that keeps the constraint from being over-tightened later.
   */
  it("allows the next candidate once the first confirmation is settled", async () => {
    await resetShortlist();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 120_000);

    expect(
      await repo.startConfirmation({
        attemptId: ids.attemptA,
        expertProfileId: ids.expertA,
        expiresAt,
        now,
      }),
    ).not.toBeNull();

    // While A is still CONFIRMING, B is refused.
    expect(
      await repo.startConfirmation({
        attemptId: ids.attemptB,
        expertProfileId: ids.expertB,
        expiresAt,
        now,
      }),
    ).toBeNull();

    await repo.settleConfirmation({
      attemptId: ids.attemptA,
      expertProfileId: ids.expertA,
      toStatus: "TIMED_OUT",
      now,
      releaseTo: null,
    });

    // And now B goes through.
    expect(
      await repo.startConfirmation({
        attemptId: ids.attemptB,
        expertProfileId: ids.expertB,
        expiresAt,
        now,
      }),
    ).not.toBeNull();
  });

  /**
   * The mirror invariant: one expert, two requests.
   *
   * Found by accident while testing the pay flow. A test selected a candidate
   * who was already confirming a *different* request, and it went through —
   * both attempts sat in CONFIRMING, and because the expert's workspace looks up
   * one pending confirmation, the second was invisible to them and expired while
   * a customer watched a countdown that could never be answered.
   *
   * Raising a hand on several requests is intended; being *asked to confirm*
   * several is not. Exclusivity has to begin the moment somebody is chosen.
   */
  it("refuses to ask one expert to confirm two requests at once", async () => {
    await resetShortlist();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 120_000);

    // A second request, shortlisting the *same* expert as the first.
    const tier = await prisma.pricingTier.findFirst({ where: { isActive: true } });
    const secondRequestId = `freq2-${STAMP}`;
    const secondAttemptId = `fatt2-${STAMP}`;
    await prisma.supportRequest.create({
      data: {
        id: secondRequestId,
        customerId: ids.customer,
        title: "A second customer, same expert",
        description: "Both shortlisted the same person.",
        state: "SEARCHING",
        matchDeadlineAt: new Date(Date.now() + 15 * 60_000),
        pricingTierId: tier!.id,
        quotedPriceCents: tier!.priceCents,
        quotedPlatformFeeCents: 0,
        quotedExpertPayoutCents: tier!.priceCents,
        matchingRuns: {
          create: {
            id: `frun2-${STAMP}`,
            roundNumber: 1,
            relaxationLevel: 0,
            weightsSnapshot: {},
            thresholdsSnapshot: {},
            candidatePoolSize: 1,
            attempts: {
              create: {
                id: secondAttemptId,
                supportRequestId: secondRequestId,
                expertProfileId: ids.expertA,
                rank: 1,
                status: "SHORTLISTED",
              },
            },
          },
        },
      },
    });

    try {
      expect(
        await repo.startConfirmation({
          attemptId: ids.attemptA,
          expertProfileId: ids.expertA,
          expiresAt,
          now,
        }),
      ).not.toBeNull();

      // The same expert, a different request. Before `one_confirming_per_expert`
      // this succeeded and produced two live confirmations for one person.
      expect(
        await repo.startConfirmation({
          attemptId: secondAttemptId,
          expertProfileId: ids.expertA,
          expiresAt,
          now,
        }),
      ).toBeNull();

      const confirming = await prisma.matchingAttempt.count({
        where: { expertProfileId: ids.expertA, status: "CONFIRMING" },
      });
      expect(confirming).toBe(1);
    } finally {
      await prisma.supportRequest.deleteMany({ where: { id: secondRequestId } });
    }
  });

  it("holds under a wider stampede", async () => {
    await resetShortlist();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 120_000);

    const attempts = [
      { attemptId: ids.attemptA, expertProfileId: ids.expertA },
      { attemptId: ids.attemptB, expertProfileId: ids.expertB },
    ] as const;

    await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) =>
        repo.startConfirmation({
          ...(index % 2 === 0 ? attempts[0] : attempts[1]),
          expiresAt,
          now,
        }),
      ),
    );

    const confirming = await prisma.matchingAttempt.findMany({
      where: { supportRequestId: ids.request, status: "CONFIRMING" },
    });
    expect(confirming).toHaveLength(1);
  });
});
