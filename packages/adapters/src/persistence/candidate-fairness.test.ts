import { PrismaClient } from "@sfx/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaCandidateRepository } from "./prisma-matching-repositories.js";

/**
 * The candidate pool rotates, against a real Postgres.
 *
 * The bug this pins down was invisible to every existing test and to the product
 * itself. The candidate query returns a bounded pool ordered by
 * least-recently-assigned. `lastAssignedAt` is null for anyone never assigned,
 * so on a bench of 92 never-assigned experts all 92 tie, and the old `id`
 * tiebreak admitted the same 50 on every run — the other 42 were never scored,
 * never offered, and left no exclusion row explaining why. An expert could sit
 * APPROVED and AVAILABLE for months and never appear in a single run.
 *
 * It needs a database because the fix *is* the SQL: a three-term ORDER BY with
 * two NULLS FIRST clauses, plus the write that advances the ledger the second
 * term reads. A fake can model that contract — and `FakeCandidateRepository`
 * does — but only Postgres can tell you the ordering actually behaves that way.
 *
 * 92 and 50 are the real numbers from the dev database where this was found.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const SKIPPED = process.env.SKIP_DB_TESTS === "1";
const describeWithDb = DATABASE_URL && !SKIPPED ? describe : describe.skip;

const prisma = new PrismaClient();
const STAMP = process.hrtime.bigint().toString(36).slice(-8);

const BENCH = 92;
const POOL = 50;

const ids = {
  customerUser: `fcu-${STAMP}`,
  customer: `fc-${STAMP}`,
  request: `freq-${STAMP}`,
  skill: `fskill-${STAMP}`,
  category: `fcat-${STAMP}`,
  expert: (n: number) => `fexp-${STAMP}-${String(n).padStart(3, "0")}`,
  expertUser: (n: number) => `fexu-${STAMP}-${String(n).padStart(3, "0")}`,
};

const everyone = Array.from({ length: BENCH }, (_, i) => ids.expert(i));

describeWithDb("candidate pool rotation", () => {
  let repo: PrismaCandidateRepository;

  beforeAll(async () => {
    repo = new PrismaCandidateRepository(prisma);

    const tier = await prisma.pricingTier.findFirst({ where: { isActive: true } });
    if (!tier) throw new Error("seed the database first: pnpm db:setup");

    // A private category and skill, so this bench is the only bench that can
    // satisfy the request and no other test's leftovers dilute the counts.
    await prisma.category.create({
      data: { id: ids.category, slug: `fairness-${STAMP}`, name: "Fairness Fixture" },
    });
    await prisma.skill.create({
      data: {
        id: ids.skill,
        categoryId: ids.category,
        slug: `fairness-skill-${STAMP}`,
        name: "Fairness Fixture Skill",
      },
    });

    await prisma.user.create({
      data: {
        id: ids.customerUser,
        email: `${ids.customerUser}@fairness.test`,
        name: "Fairness Customer",
        roles: ["CUSTOMER"],
        customer: { create: { id: ids.customer } },
      },
    });

    await prisma.user.createMany({
      data: everyone.map((_, i) => ({
        id: ids.expertUser(i),
        email: `${ids.expertUser(i)}@fairness.test`,
        name: `Fairness Expert ${String(i)}`,
        roles: ["CUSTOMER" as const, "EXPERT" as const],
      })),
    });
    await prisma.expertProfile.createMany({
      data: everyone.map((id, i) => ({
        id,
        userId: ids.expertUser(i),
        status: "APPROVED" as const,
        availabilityStatus: "AVAILABLE" as const,
        lastHeartbeatAt: new Date(),
        country: "IN",
        timezone: "Asia/Kolkata",
        yearsExperience: 8,
        professionalSummary: "x".repeat(100),
        // The whole point: nobody has ever been assigned anything, so every one
        // of them ties on the primary ordering term.
        lastAssignedAt: null,
      })),
    });
    await prisma.expertSkill.createMany({
      data: everyone.map((id) => ({
        expertProfileId: id,
        skillId: ids.skill,
        proficiencyLevel: "EXPERT" as const,
        yearsExperience: 6,
      })),
    });

    await prisma.supportRequest.create({
      data: {
        id: ids.request,
        customerId: ids.customer,
        title: "Fairness fixture",
        description: "Used to exercise candidate pool rotation.",
        state: "SEARCHING",
        matchDeadlineAt: new Date(Date.now() + 15 * 60_000),
        pricingTierId: tier.id,
        quotedPriceCents: tier.priceCents,
        quotedPlatformFeeCents: 0,
        quotedExpertPayoutCents: tier.priceCents,
      },
    });
  });

  afterAll(async () => {
    await prisma.supportRequest.deleteMany({ where: { id: ids.request } }).catch(() => undefined);
    await prisma.expertSkill.deleteMany({ where: { skillId: ids.skill } }).catch(() => undefined);
    await prisma.expertProfile
      .deleteMany({ where: { id: { in: everyone } } })
      .catch(() => undefined);
    await prisma.user
      .deleteMany({
        where: { id: { in: [ids.customerUser, ...everyone.map((_, i) => ids.expertUser(i))] } },
      })
      .catch(() => undefined);
    await prisma.skill.deleteMany({ where: { id: ids.skill } }).catch(() => undefined);
    await prisma.category.deleteMany({ where: { id: ids.category } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  async function reset(): Promise<void> {
    await prisma.expertProfile.updateMany({
      where: { id: { in: everyone } },
      data: { lastAssignedAt: null, lastConsideredAt: null },
    });
  }

  /** One dispatch's worth of pool selection. Returns who got in. */
  async function round(now: Date): Promise<string[]> {
    const rows = await repo.findCandidates({
      supportRequestId: ids.request,
      requiredSkillIds: [ids.skill],
      now,
      limit: POOL,
    });
    return rows.map((row) => row.candidate.expertProfileId);
  }

  it("does not permanently starve the tail: two rounds reach all 92", async () => {
    await reset();

    const first = await round(new Date("2026-08-12T10:00:00Z"));
    expect(first).toHaveLength(POOL);

    const second = await round(new Date("2026-08-12T10:01:00Z"));
    expect(second).toHaveLength(POOL);

    // The 42 nobody had looked at yet lead the second round, because null sorts
    // ahead of any stamp. Under the old ordering `second` was identical to
    // `first` and these 42 were unreachable forever.
    const tail = everyone.filter((id) => !first.includes(id));
    expect(tail).toHaveLength(BENCH - POOL);
    expect(tail.every((id) => second.includes(id))).toBe(true);

    const reached = new Set([...first, ...second]);
    expect(reached.size).toBe(BENCH);
  });

  it("keeps rotating: over ten rounds nobody is left behind and nobody dominates", async () => {
    await reset();

    const seen = new Map<string, number>(everyone.map((id) => [id, 0]));
    for (let i = 0; i < 10; i += 1) {
      const now = new Date(Date.UTC(2026, 7, 12, 11, i));
      for (const id of await round(now)) seen.set(id, (seen.get(id) ?? 0) + 1);
    }

    const counts = [...seen.values()];
    expect(Math.min(...counts)).toBeGreaterThan(0);

    // 10 rounds × 50 slots over 92 experts is ~5.4 each. A spread wider than one
    // would mean the rotation is drifting rather than cycling.
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it("still prefers the least recently assigned — fairness order is unchanged", async () => {
    await reset();

    // One expert was assigned work a minute ago; one an hour ago; the rest never.
    const [recent, older] = [everyone[0], everyone[1]] as [string, string];
    await prisma.expertProfile.update({
      where: { id: recent },
      data: { lastAssignedAt: new Date("2026-08-12T11:59:00Z") },
    });
    await prisma.expertProfile.update({
      where: { id: older },
      data: { lastAssignedAt: new Date("2026-08-12T11:00:00Z") },
    });

    const pool = await round(new Date("2026-08-12T12:00:00Z"));

    // Both assigned experts sort behind all 90 never-assigned ones, so with a
    // pool of 50 neither makes the cut. Never-assigned first is the rule this
    // change was careful not to disturb.
    expect(pool).not.toContain(recent);
    expect(pool).not.toContain(older);
    expect(pool).toHaveLength(POOL);
  });

  it("is reproducible: the same ledger state yields the same pool", async () => {
    await reset();

    const now = new Date("2026-08-12T13:00:00Z");
    const first = await round(now);

    // Rewind the ledger to exactly what it was, and ask again.
    await reset();
    const again = await round(now);

    expect(again).toEqual(first);
  });

  it("records consideration for everyone it returned, and nobody it did not", async () => {
    await reset();

    const now = new Date("2026-08-12T14:00:00Z");
    const pool = await round(now);

    const stamped = await prisma.expertProfile.findMany({
      where: { id: { in: everyone }, lastConsideredAt: { not: null } },
      select: { id: true },
    });
    expect(stamped.map((row) => row.id).sort()).toEqual([...pool].sort());
  });
});
