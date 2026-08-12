import { describe, expect, it } from "vitest";
import type { Candidate, RequiredSkill } from "../ports/matching-repositories.js";
import type { CandidateEligibility, FilterContext } from "./filters.js";
import { candidate, candidateRow, FakeCandidateRepository } from "./in-memory-matching-world.js";
import { rankCandidates } from "./rank.js";
import { DEFAULT_SCORING_THRESHOLDS, DEFAULT_WEIGHTS, scoreCandidate } from "./scoring.js";

/**
 * The candidate pool rotates, and rotating it changes nothing about ranking.
 *
 * Two separate claims, and the second is the one worth being careful about. Pool
 * membership and ranking are different decisions made by different code: the
 * repository decides *who is looked at* under a bound, the domain decides *who
 * is best* among them. The fairness fix touches only the first. These tests pin
 * that boundary, because a change that quietly let admission order leak into
 * scores would make "why this expert?" unanswerable from the audit trail — the
 * property the whole matching design exists to preserve.
 *
 * The database-level proof of the rotation itself lives in the adapters package,
 * where a real Postgres can be held to the ordering. This file proves the
 * contract the domain depends on.
 */

const NOW = new Date("2026-08-12T12:00:00Z");
const POOL = 50;
const BENCH = 92;

const THRESHOLDS: FilterContext["thresholds"] = {
  ...DEFAULT_SCORING_THRESHOLDS,
  minRating: 3.5,
  minRatedSessions: 3,
  heartbeatStaleAfterSeconds: 180,
};

const ELIGIBLE: CandidateEligibility = {
  expertStatus: "APPROVED",
  accountStatus: "ACTIVE",
  availabilityStatus: "AVAILABLE",
  lastHeartbeatAt: NOW,
  alreadyResponded: false,
  isRequestingCustomer: false,
};

const required: RequiredSkill[] = [
  { skillId: "apex", slug: "apex", categoryId: "cat_dev", isPrimary: true },
];

function rank(candidates: Candidate[]) {
  return rankCandidates({
    required,
    candidates: candidates.map((c) => ({ candidate: c, eligibility: ELIGIBLE })),
    relaxationLevel: 0,
    weights: DEFAULT_WEIGHTS,
    thresholds: THRESHOLDS,
    customerLanguages: [],
    now: NOW,
    poolSize: 10,
    tieBreakSeed: "req_rotation",
  });
}

function score(person: Candidate) {
  return scoreCandidate({
    required,
    candidate: person,
    weights: DEFAULT_WEIGHTS,
    thresholds: THRESHOLDS,
    allowCategorySubstitute: false,
  });
}

/** A bench of identically-qualified, never-assigned experts. */
function bench(size = BENCH) {
  const repo = new FakeCandidateRepository();
  repo.rows = Array.from({ length: size }, (_, i) =>
    candidateRow({
      id: `exp_${String(i).padStart(3, "0")}`,
      skills: { apex: "EXPERT" },
      // Never assigned: every one of them ties on the primary ordering term,
      // which is the condition that used to make the cut permanent.
      idleMinutes: null,
    }),
  );
  return repo;
}

async function poolAt(repo: FakeCandidateRepository, minute: number): Promise<string[]> {
  const rows = await repo.findCandidates({
    supportRequestId: "req_rotation",
    requiredSkillIds: ["apex"],
    now: new Date(NOW.getTime() + minute * 60_000),
    limit: POOL,
  });
  return rows.map((row) => row.candidate.expertProfileId);
}

// ── The rotation ─────────────────────────────────────────────────────────────

describe("a bounded pool over a bench that cannot all fit", () => {
  it("admits exactly the bound, not the whole bench", async () => {
    expect(await poolAt(bench(), 0)).toHaveLength(POOL);
  });

  it("does not strand the tail: 92 never-assigned experts are all reached in two rounds", async () => {
    const repo = bench();
    const first = await poolAt(repo, 0);
    const second = await poolAt(repo, 1);

    const tail = repo.rows
      .map((row) => row.candidate.expertProfileId)
      .filter((id) => !first.includes(id));
    expect(tail).toHaveLength(BENCH - POOL);

    // Under a stable tiebreak `second` was byte-identical to `first` and these
    // 42 experts were unreachable for the lifetime of the platform.
    expect(second).not.toEqual(first);
    expect(tail.every((id) => second.includes(id))).toBe(true);
    expect(new Set([...first, ...second]).size).toBe(BENCH);
  });

  it("keeps cycling, without letting anyone be considered twice as often", async () => {
    const repo = bench();
    const seen = new Map<string, number>(
      repo.rows.map((row) => [row.candidate.expertProfileId, 0]),
    );

    for (let round = 0; round < 12; round += 1) {
      for (const id of await poolAt(repo, round)) seen.set(id, (seen.get(id) ?? 0) + 1);
    }

    const counts = [...seen.values()];
    expect(Math.min(...counts)).toBeGreaterThan(0);
    // A queue, not a set: everyone is within one round of everyone else. A
    // shared consideration stamp would put a handful of experts on every single
    // round and leave this spread far wider.
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it("is reproducible — the same ledger state yields the same pool", async () => {
    expect(await poolAt(bench(), 0)).toEqual(await poolAt(bench(), 0));
  });

  it("still puts never-assigned experts ahead of recently-assigned ones", async () => {
    const repo = bench(3);
    repo.rows = [
      candidateRow({ id: "assigned_recently", skills: { apex: "EXPERT" }, idleMinutes: 5 }),
      candidateRow({ id: "assigned_long_ago", skills: { apex: "EXPERT" }, idleMinutes: 600 }),
      candidateRow({ id: "never_assigned", skills: { apex: "EXPERT" }, idleMinutes: null }),
    ];

    const rows = await repo.findCandidates({
      supportRequestId: "req_rotation",
      requiredSkillIds: ["apex"],
      now: NOW,
      limit: 2,
    });

    // Fairness order is unchanged by the rotation: never-assigned first, then
    // longest-waiting. The recently-assigned expert is the one cut.
    expect(rows.map((row) => row.candidate.expertProfileId)).toEqual([
      "never_assigned",
      "assigned_long_ago",
    ]);
  });
});

// ── The boundary: rotation must not touch ranking ────────────────────────────

describe("rotation does not alter ranking semantics", () => {
  const strong = candidate({ id: "strong", skills: { apex: "EXPERT" }, yearsExperience: 12 });
  const weak = candidate({ id: "weak", skills: { apex: "INTERMEDIATE" }, yearsExperience: 1 });

  it("prefers the stronger candidate regardless of the order the pool produced", () => {
    const forwards = rank([strong, weak]);
    const backwards = rank([weak, strong]);

    expect(forwards.ranked[0]?.expertProfileId).toBe("strong");
    expect(backwards.ranked[0]?.expertProfileId).toBe("strong");
    // Not merely the same winner — the same ranking, whole.
    expect(backwards.ranked.map((r) => r.expertProfileId)).toEqual(
      forwards.ranked.map((r) => r.expertProfileId),
    );
  });

  it("produces identical scores whatever order candidates arrived in", () => {
    const forwards = rank([strong, weak]);
    const backwards = rank([weak, strong]);

    for (const entry of forwards.ranked) {
      const other = backwards.ranked.find((r) => r.expertProfileId === entry.expertProfileId);
      expect(other?.score.finalScore).toBe(entry.score.finalScore);
      expect(other?.score.breakdown).toEqual(entry.score.breakdown);
    }
  });

  it("scores a candidate the same whether or not they were recently considered", () => {
    // `lastConsideredAt` has no route into scoring — it is not on `Candidate` at
    // all. This asserts the consequence: the score is a function of the expert
    // and the request, and of nothing about how they were fetched.
    const before = score(strong);
    const after = score(strong);
    expect(after).toEqual(before);
    expect(Object.keys(before.breakdown)).not.toContain("lastConsideredAt");
  });

  it("a rotated pool still ranks by score, not by admission order", async () => {
    const repo = new FakeCandidateRepository();
    repo.rows = [
      candidateRow({ id: "aaa_weak", skills: { apex: "INTERMEDIATE" }, yearsExperience: 1 }),
      candidateRow({ id: "zzz_strong", skills: { apex: "EXPERT" }, yearsExperience: 12 }),
    ];

    const rows = await repo.findCandidates({
      supportRequestId: "req_rotation",
      requiredSkillIds: ["apex"],
      now: NOW,
      limit: 10,
    });

    // The weaker expert is admitted first — the pool is ordered by fairness, and
    // `aaa_weak` wins that on id. Ranking must then ignore it entirely.
    expect(rows[0]?.candidate.expertProfileId).toBe("aaa_weak");
    expect(rank(rows.map((row) => row.candidate)).ranked[0]?.expertProfileId).toBe("zzz_strong");
  });
});
