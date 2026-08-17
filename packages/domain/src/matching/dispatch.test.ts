import { beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../authorization/index.js";
import { FixedClock } from "../ports/clock.js";
import type { SupportRequestRecord } from "../ports/request-repositories.js";
import { ConflictError, ForbiddenError, ValidationError } from "../shared/errors.js";
import { InMemoryUnitOfWork } from "../experts/in-memory-uow.js";
import {
  FakeRequestRepository,
  FakeScheduler,
  SilentLogger,
} from "../support-requests/in-memory-request-world.js";
import {
  candidateRow,
  FakeCandidateRepository,
  FakeMatchingRepository,
  resetMatchingIds,
} from "./in-memory-matching-world.js";
import { MatchingService, DEFAULT_MATCHING_THRESHOLDS } from "./matching-service.js";

/**
 * The dispatch loop (§15) — requirements 6 through 14.
 *
 * These run against fakes that model the database's invariants rather than
 * permissive stubs: the partial unique index, the guarded status writes, the
 * availability lock. A test that passes here is testing the thing production
 * relies on.
 */

const T0 = new Date("2026-08-02T12:00:00Z");
const DEADLINE = new Date(T0.getTime() + 15 * 60_000);

let clock: FixedClock;
let requests: FakeRequestRepository;
let matching: FakeMatchingRepository;
let candidates: FakeCandidateRepository;
let scheduler: FakeScheduler;
let logger: SilentLogger;
let uow: InMemoryUnitOfWork;
let service: MatchingService;

const QUEUES = {
  dispatchNextOffer: "dispatch-next-offer",
  offerTimeout: "offer-timeout",
  matchingDeadline: "matching-deadline",
};

function seedRequest(overrides: Partial<SupportRequestRecord> = {}): SupportRequestRecord {
  const record: SupportRequestRecord = {
    id: "req_1",
    customerId: "cust_1",
    title: "Apex governor limits",
    description: "Too many SOQL queries on a bulk load.",
    state: "SEARCHING",
    stateEnteredAt: T0,
    version: 0,
    primaryCategoryId: "cat_dev",
    difficulty: "ADVANCED",
    aiConfidence: 0.9,
    aiClassifiedAt: T0,
    aiModel: "rules",
    aiFailureReason: null,
    matchDeadlineAt: DEADLINE,
    assignedExpertId: null,
    pricingTierId: "tier_30",
    quotedPriceCents: 100_000,
    currency: "INR",
    quotedPlatformFeeCents: 25_000,
    quotedExpertPayoutCents: 75_000,
    paymentAuthorizationRef: "auth_1",
    cancelledAt: null,
    cancellationReason: null,
    createdAt: T0,
    updatedAt: T0,
    skills: [
      {
        skillId: "apex",
        slug: "apex",
        name: "Apex",
        source: "AI_DETECTED",
        isPrimary: true,
        confidence: 0.9,
      },
    ],
    attachmentCount: 0,
    ...overrides,
  };
  requests.rows.set(record.id, record);
  return record;
}

function expertActor(profileId: string): Actor {
  return {
    userId: `user_${profileId}`,
    email: `${profileId}@example.com`,
    roles: ["CUSTOMER", "EXPERT"],
    status: "ACTIVE",
    emailVerified: true,
    expert: { profileId, status: "APPROVED" },
  };
}

const admin: Actor = {
  userId: "admin_1",
  email: "admin@example.com",
  roles: ["CUSTOMER", "ADMIN"],
  status: "ACTIVE",
  emailVerified: true,
};

beforeEach(() => {
  resetMatchingIds();
  clock = new FixedClock(T0);
  requests = new FakeRequestRepository();
  matching = new FakeMatchingRepository();
  candidates = new FakeCandidateRepository();
  scheduler = new FakeScheduler();
  logger = new SilentLogger();
  uow = new InMemoryUnitOfWork();
  service = new MatchingService({
    requests,
    matching,
    candidates,
    auditLog: uow.auditLog,
    scheduler,
    clock,
    logger,
    queues: QUEUES,
  });
});

/** Three competent Apex experts, ranked A > B > C by idle time. */
function seedThreeExperts(): void {
  candidates.rows = [
    candidateRow({ id: "expA", skills: { apex: ["EXPERT", 8] }, idleMinutes: 240 }),
    candidateRow({ id: "expB", skills: { apex: ["EXPERT", 8] }, idleMinutes: 120 }),
    candidateRow({ id: "expC", skills: { apex: ["EXPERT", 8] }, idleMinutes: 10 }),
  ];
  for (const id of ["expA", "expB", "expC"]) matching.seedAvailability(id, "AVAILABLE");
}

// ── The happy path ───────────────────────────────────────────────────────────

describe("the dispatch loop", () => {
  it("offers to the best-ranked candidate and moves the request to OFFERED", async () => {
    seedRequest();
    seedThreeExperts();

    const outcome = await service.dispatchNextOffer("req_1");

    expect(outcome.action).toBe("OFFERED");
    expect(outcome.attempt?.expertProfileId).toBe("expA");
    expect(requests.rows.get("req_1")?.state).toBe("OFFERED");
    expect(matching.availability.get("expA")).toBe("ON_OFFER");
  });

  it("records every candidate it considered, ranked and excluded", async () => {
    seedRequest();
    candidates.rows = [
      candidateRow({ id: "good", skills: { apex: ["EXPERT", 8] } }),
      candidateRow({ id: "belowFloor", skills: { apex: ["BEGINNER", 1] } }),
      candidateRow({
        id: "offline",
        skills: { apex: ["EXPERT", 8] },
        availabilityStatus: "OFFLINE",
      }),
    ];
    matching.seedAvailability("good", "AVAILABLE");

    await service.dispatchNextOffer("req_1");

    const attempts = await matching.listAttemptsForRequest("req_1");
    const excluded = attempts.filter((a) => a.status === "EXCLUDED");
    // Requirement 4: an operator asking "why not them" gets an answer for
    // everyone, not just for the people who nearly won.
    expect(excluded).toHaveLength(2);
    expect(excluded.find((a) => a.expertProfileId === "belowFloor")?.exclusionReasons).toContain(
      "PRIMARY_BELOW_FLOOR",
    );
    expect(excluded.find((a) => a.expertProfileId === "offline")?.exclusionReasons).toContain(
      "NOT_AVAILABLE",
    );
  });

  it("persists the score components that reproduce the decision", async () => {
    seedRequest();
    seedThreeExperts();
    await service.dispatchNextOffer("req_1");

    const attempts = await matching.listAttemptsForRequest("req_1");
    const winner = attempts.find((a) => a.status === "OFFERED");
    expect(winner?.finalScore).toBeGreaterThan(0);
    expect(winner?.skillScore).toBeGreaterThan(0);
    expect(winner?.scoreBreakdown).toHaveProperty("primaryBand");
    expect(winner?.scoreBreakdown).toHaveProperty("perSkill");
  });

  it("schedules the offer timeout for the stored expiry, not a recomputed one", async () => {
    seedRequest();
    seedThreeExperts();
    const outcome = await service.dispatchNextOffer("req_1");

    const job = scheduler.jobs.find((j) => j.queue === QUEUES.offerTimeout);
    expect(job).toBeDefined();
    expect(job?.singletonKey).toBe(`offer-timeout:${outcome.attempt?.id ?? ""}`);
    expect(outcome.attempt?.offerExpiresAt?.getTime()).toBe(
      T0.getTime() + DEFAULT_MATCHING_THRESHOLDS.offerWindowSeconds * 1000,
    );
  });

  it("is a no-op when the request already has an open offer", async () => {
    seedRequest();
    seedThreeExperts();
    await service.dispatchNextOffer("req_1");
    const second = await service.dispatchNextOffer("req_1");
    expect(second.action).toBe("ALREADY_OFFERED");
  });

  it("does nothing for a request that is no longer being matched", async () => {
    seedRequest({ state: "ACCEPTED" });
    const outcome = await service.dispatchNextOffer("req_1");
    expect(outcome.action).toBe("NOT_SEARCHING");
  });

  it("gives up rather than offering to nobody suitable", async () => {
    seedRequest();
    candidates.rows = [candidateRow({ id: "wrong", skills: { flow: ["EXPERT", 9] } })];
    clock.advanceBy(13 * 60_000); // past the level-3 schedule

    const outcome = await service.dispatchNextOffer("req_1");
    expect(outcome.action).toBe("NO_EXPERT_FOUND");
    expect(requests.rows.get("req_1")?.state).toBe("NO_EXPERT_FOUND");
  });
});

// ── Requirement 6: concurrency ───────────────────────────────────────────────

describe("requirement 6 — two requests racing for the same expert", () => {
  it("lets exactly one hold the offer and re-routes the other", async () => {
    seedRequest();
    seedRequest({ id: "req_2", customerId: "cust_2", version: 0 });
    candidates.rows = [
      candidateRow({ id: "star", skills: { apex: ["EXPERT", 9] }, idleMinutes: 300 }),
      candidateRow({ id: "second", skills: { apex: ["EXPERT", 8] }, idleMinutes: 200 }),
    ];
    matching.seedAvailability("star", "AVAILABLE");
    matching.seedAvailability("second", "AVAILABLE");

    // Both dispatchers rank `star` first. Only one can hold the offer.
    const [first, other] = await Promise.all([
      service.dispatchNextOffer("req_1"),
      service.dispatchNextOffer("req_2"),
    ]);

    expect(first.action).toBe("OFFERED");
    expect(other.action).toBe("OFFERED");
    const offered = [first.attempt?.expertProfileId, other.attempt?.expertProfileId].sort();
    // One got the star, the other fell through to the next candidate — nobody
    // waited and nobody double-booked.
    expect(offered).toEqual(["second", "star"]);

    const starOffers = matching.attempts.filter(
      (a) => a.expertProfileId === "star" && a.status === "OFFERED",
    );
    expect(starOffers).toHaveLength(1);
  });

  it("marks the loser's attempt WITHDRAWN without touching their reliability", async () => {
    seedRequest();
    candidates.rows = [
      candidateRow({ id: "taken", skills: { apex: ["EXPERT", 9] }, idleMinutes: 300 }),
      candidateRow({ id: "free", skills: { apex: ["EXPERT", 8] }, idleMinutes: 200 }),
    ];
    matching.seedAvailability("taken", "AVAILABLE");
    matching.seedAvailability("free", "AVAILABLE");

    // Simulate the expert being offered another request microseconds earlier.
    matching.attempts.push({
      id: "att_elsewhere",
      matchingRunId: "run_other",
      supportRequestId: "req_other",
      expertProfileId: "taken",
      origin: "ALGORITHMIC",
      rank: 1,
      status: "OFFERED",
      skillScore: 0,
      experienceScore: 0,
      ratingScore: 0,
      fairnessScore: 0,
      reliabilityScore: 0,
      finalScore: 0,
      scoreBreakdown: {},
      exclusionReasons: [],
      offeredAt: T0,
      offerExpiresAt: new Date(T0.getTime() + 60_000),
      respondedAt: null,
      responseSeconds: null,
      declineReason: null,
      declineNote: null,
      adminReason: null,
      createdAt: T0,
    });

    const outcome = await service.dispatchNextOffer("req_1");
    expect(outcome.attempt?.expertProfileId).toBe("free");

    const withdrawn = matching.attempts.find(
      (a) => a.expertProfileId === "taken" && a.supportRequestId === "req_1",
    );
    expect(withdrawn?.status).toBe("WITHDRAWN");
    // Losing a race is not a decline. It must not damage their acceptance rate.
    expect(matching.reliabilityHits).not.toContain(withdrawn?.id);
  });
});

// ── Requirement 8: the offer window is durable ───────────────────────────────

describe("requirement 8 — the 60-second window is durable", () => {
  async function openOffer() {
    seedRequest();
    seedThreeExperts();
    const outcome = await service.dispatchNextOffer("req_1");
    return outcome.attempt!;
  }

  it("stores the expiry on the attempt", async () => {
    const attempt = await openOffer();
    expect(attempt.offerExpiresAt).toEqual(new Date(T0.getTime() + 60_000));
  });

  it("refuses to expire early and re-schedules for the remaining time", async () => {
    const attempt = await openOffer();
    clock.advanceBy(30_000);

    const result = await service.expireOffer(attempt.id);
    expect(result.expired).toBe(false);
    expect(result.reason).toMatch(/has not closed yet/);
    expect(matching.attempts.find((a) => a.id === attempt.id)?.status).toBe("OFFERED");

    // Re-scheduled for what is left, not for another full window.
    const retry = scheduler.jobs.filter((j) => j.singletonKey?.endsWith(":retry"));
    expect(retry).toHaveLength(1);
  });

  it("does not extend the window when the job is delivered twice", async () => {
    const attempt = await openOffer();
    const originalExpiry = attempt.offerExpiresAt;

    clock.advanceBy(20_000);
    await service.expireOffer(attempt.id);
    clock.advanceBy(20_000);
    await service.expireOffer(attempt.id);

    expect(matching.attempts.find((a) => a.id === attempt.id)?.offerExpiresAt).toEqual(
      originalExpiry,
    );
  });

  it("expires once the stored deadline has genuinely passed", async () => {
    const attempt = await openOffer();
    clock.advanceBy(61_000);

    const result = await service.expireOffer(attempt.id);
    expect(result.expired).toBe(true);
    expect(matching.attempts.find((a) => a.id === attempt.id)?.status).toBe("TIMED_OUT");
  });

  it("re-offering the same request never reuses the old window", async () => {
    const attempt = await openOffer();
    clock.advanceBy(61_000);
    await service.expireOffer(attempt.id);

    // Back to SEARCHING; the worker re-dispatches.
    expect(requests.rows.get("req_1")?.state).toBe("SEARCHING");
    const next = await service.dispatchNextOffer("req_1");
    expect(next.attempt?.expertProfileId).toBe("expB");
    expect(next.attempt?.offerExpiresAt?.getTime()).toBe(clock.now().getTime() + 60_000);
  });

  it("never lets an offer window outlive the matching deadline", async () => {
    seedRequest();
    seedThreeExperts();
    // 40 seconds before the deadline: a full 60-second window would overrun it.
    clock.advanceBy(15 * 60_000 - 40_000);

    const outcome = await service.dispatchNextOffer("req_1");
    expect(outcome.attempt?.offerExpiresAt).toEqual(DEADLINE);
  });
});

// ── Requirement 7: the 15-minute deadline never resets ───────────────────────

describe("requirement 7 — the matching deadline is measured from submission", () => {
  it("is scheduled once, from the stored value", async () => {
    seedRequest();
    seedThreeExperts();
    await service.beginSearch("req_1");

    const deadlineJobs = scheduler.jobs.filter((j) => j.queue === QUEUES.matchingDeadline);
    expect(deadlineJobs).toHaveLength(1);
    expect(deadlineJobs[0]?.singletonKey).toBe("deadline:req_1");
  });

  it("is not reset when an offer expires", async () => {
    seedRequest();
    seedThreeExperts();
    const first = await service.dispatchNextOffer("req_1");
    const before = requests.rows.get("req_1")?.matchDeadlineAt;

    clock.advanceBy(61_000);
    await service.expireOffer(first.attempt!.id);
    await service.dispatchNextOffer("req_1");

    expect(requests.rows.get("req_1")?.matchDeadlineAt).toEqual(before);
  });

  it("is not reset when the relaxation level changes", async () => {
    seedRequest();
    candidates.rows = [candidateRow({ id: "mid", skills: { apex: ["INTERMEDIATE", 4] } })];
    matching.seedAvailability("mid", "AVAILABLE");
    const before = requests.rows.get("req_1")?.matchDeadlineAt;

    clock.advanceBy(9 * 60_000); // level 2 is due; INTERMEDIATE now qualifies
    await service.dispatchNextOffer("req_1");

    expect(requests.rows.get("req_1")?.matchDeadlineAt).toEqual(before);
  });

  it("gives up at the deadline even with candidates still queued", async () => {
    seedRequest();
    seedThreeExperts();
    clock.advanceBy(15 * 60_000 + 1000);

    const outcome = await service.dispatchNextOffer("req_1");
    expect(outcome.action).toBe("DEADLINE_PASSED");
    expect(requests.rows.get("req_1")?.state).toBe("NO_EXPERT_FOUND");
  });

  it("withdraws an offer that was still open at the deadline, blaming nobody", async () => {
    seedRequest();
    seedThreeExperts();
    const outcome = await service.dispatchNextOffer("req_1");
    clock.advanceBy(15 * 60_000 + 1000);

    const result = await service.expireMatching("req_1");
    expect(result.gaveUp).toBe(true);
    const attempt = matching.attempts.find((a) => a.id === outcome.attempt?.id);
    expect(attempt?.status).toBe("WITHDRAWN");
    // They may have been mid-click. Not their fault.
    expect(matching.reliabilityHits).not.toContain(attempt?.id);
    expect(requests.rows.get("req_1")?.state).toBe("NO_EXPERT_FOUND");
  });

  it("does nothing before the deadline", async () => {
    seedRequest();
    seedThreeExperts();
    await service.dispatchNextOffer("req_1");
    const result = await service.expireMatching("req_1");
    expect(result.gaveUp).toBe(false);
    expect(result.reason).toMatch(/has not passed/);
  });
});

// ── Requirements 9 and 10: accept, decline, timeout ──────────────────────────

describe("accepting an offer", () => {
  it("assigns the expert and moves the request to ACCEPTED", async () => {
    seedRequest();
    seedThreeExperts();
    const outcome = await service.dispatchNextOffer("req_1");

    clock.advanceBy(12_000);
    const accepted = await service.acceptOffer(expertActor("expA"), outcome.attempt!.id);

    expect(accepted.status).toBe("ACCEPTED");
    expect(accepted.responseSeconds).toBe(12);
    expect(requests.rows.get("req_1")?.state).toBe("ACCEPTED");
    expect(requests.rows.get("req_1")?.assignedExpertId).toBe("expA");
    expect(matching.availability.get("expA")).toBe("IN_SESSION");
  });

  it("supersedes the remaining ranked candidates", async () => {
    seedRequest();
    seedThreeExperts();
    const outcome = await service.dispatchNextOffer("req_1");
    await service.acceptOffer(expertActor("expA"), outcome.attempt!.id);

    const stillRanked = matching.attempts.filter((a) => a.status === "RANKED");
    expect(stillRanked).toHaveLength(0);
    expect(matching.attempts.filter((a) => a.status === "SUPERSEDED")).toHaveLength(2);
  });

  it("is idempotent — a double-click is not an error", async () => {
    seedRequest();
    seedThreeExperts();
    const outcome = await service.dispatchNextOffer("req_1");
    await service.acceptOffer(expertActor("expA"), outcome.attempt!.id);

    const again = await service.acceptOffer(expertActor("expA"), outcome.attempt!.id);
    expect(again.status).toBe("ACCEPTED");
  });

  it("refuses an accept that arrives after the stored expiry", async () => {
    seedRequest();
    seedThreeExperts();
    const outcome = await service.dispatchNextOffer("req_1");

    clock.advanceBy(65_000);
    // The timeout job has not run yet, but the deadline is the authority.
    await expect(service.acceptOffer(expertActor("expA"), outcome.attempt!.id)).rejects.toThrow(
      /expired/,
    );
  });

  it("refuses an expert accepting somebody else's offer", async () => {
    seedRequest();
    seedThreeExperts();
    const outcome = await service.dispatchNextOffer("req_1");
    await expect(service.acceptOffer(expertActor("expB"), outcome.attempt!.id)).rejects.toThrow(
      ForbiddenError,
    );
  });

  it("tells an expert plainly when the offer has already timed out", async () => {
    seedRequest();
    seedThreeExperts();
    const outcome = await service.dispatchNextOffer("req_1");
    clock.advanceBy(61_000);
    await service.expireOffer(outcome.attempt!.id);

    await expect(service.acceptOffer(expertActor("expA"), outcome.attempt!.id)).rejects.toThrow(
      /ran out of time/,
    );
  });
});

describe("declining an offer (requirements 9 and 10)", () => {
  it("does not require a reason", async () => {
    seedRequest();
    seedThreeExperts();
    const outcome = await service.dispatchNextOffer("req_1");

    const declined = await service.declineOffer(expertActor("expA"), outcome.attempt!.id);
    expect(declined.status).toBe("DECLINED");
    expect(declined.declineReason).toBeNull();
  });

  it("records a structured reason when one is offered", async () => {
    seedRequest();
    seedThreeExperts();
    const outcome = await service.dispatchNextOffer("req_1");

    const declined = await service.declineOffer(expertActor("expA"), outcome.attempt!.id, {
      reason: "NOT_MY_EXPERTISE",
      note: "This is really a CPQ pricing question.",
    });
    expect(declined.declineReason).toBe("NOT_MY_EXPERTISE");
    expect(declined.declineNote).toBe("This is really a CPQ pricing question.");
  });

  it("returns the expert to AVAILABLE and re-dispatches", async () => {
    seedRequest();
    seedThreeExperts();
    const outcome = await service.dispatchNextOffer("req_1");
    await service.declineOffer(expertActor("expA"), outcome.attempt!.id);

    expect(matching.availability.get("expA")).toBe("AVAILABLE");
    expect(requests.rows.get("req_1")?.state).toBe("SEARCHING");
    expect(scheduler.jobs.some((j) => j.queue === QUEUES.dispatchNextOffer)).toBe(true);
  });

  it("never offers the same request to someone who already declined it", async () => {
    seedRequest();
    seedThreeExperts();
    const first = await service.dispatchNextOffer("req_1");
    await service.declineOffer(expertActor("expA"), first.attempt!.id);

    const second = await service.dispatchNextOffer("req_1");
    expect(second.attempt?.expertProfileId).toBe("expB");
  });

  it("keeps a decline distinct from a timeout", async () => {
    // Requirement 10. Silence is not an answer, and the two must never be
    // conflated — an expert who declines has told us something.
    seedRequest();
    seedThreeExperts();

    const first = await service.dispatchNextOffer("req_1");
    await service.declineOffer(expertActor("expA"), first.attempt!.id, {
      reason: "TOO_COMPLEX",
    });

    const second = await service.dispatchNextOffer("req_1");
    clock.advanceBy(61_000);
    await service.expireOffer(second.attempt!.id);

    const statuses = matching.attempts
      .filter((a) => a.status === "DECLINED" || a.status === "TIMED_OUT")
      .map((a) => [a.expertProfileId, a.status, a.declineReason]);
    expect(statuses).toEqual([
      ["expA", "DECLINED", "TOO_COMPLEX"],
      ["expB", "TIMED_OUT", null],
    ]);
  });

  it("rejects an absurdly long note", async () => {
    seedRequest();
    seedThreeExperts();
    const outcome = await service.dispatchNextOffer("req_1");
    await expect(
      service.declineOffer(expertActor("expA"), outcome.attempt!.id, { note: "x".repeat(600) }),
    ).rejects.toThrow(ValidationError);
  });

  it("is idempotent", async () => {
    seedRequest();
    seedThreeExperts();
    const outcome = await service.dispatchNextOffer("req_1");
    await service.declineOffer(expertActor("expA"), outcome.attempt!.id);
    const again = await service.declineOffer(expertActor("expA"), outcome.attempt!.id);
    expect(again.status).toBe("DECLINED");
  });

  it("gives up when the last candidate declines", async () => {
    seedRequest();
    candidates.rows = [candidateRow({ id: "only", skills: { apex: ["EXPERT", 9] } })];
    matching.seedAvailability("only", "AVAILABLE");
    clock.advanceBy(13 * 60_000);

    const outcome = await service.dispatchNextOffer("req_1");
    await service.declineOffer(expertActor("only"), outcome.attempt!.id);
    await service.dispatchNextOffer("req_1");

    expect(requests.rows.get("req_1")?.state).toBe("NO_EXPERT_FOUND");
  });
});

describe("accept racing timeout", () => {
  it("produces exactly one winner", async () => {
    seedRequest();
    seedThreeExperts();
    const outcome = await service.dispatchNextOffer("req_1");
    clock.advanceBy(61_000);

    const [accept, expire] = await Promise.allSettled([
      service.acceptOffer(expertActor("expA"), outcome.attempt!.id),
      service.expireOffer(outcome.attempt!.id),
    ]);

    // The accept arrived after the stored expiry, so the timeout is correct and
    // the accept is refused — the deadline decides, not who ran first.
    expect(accept.status).toBe("rejected");
    expect(expire.status).toBe("fulfilled");
    expect(matching.attempts.find((a) => a.id === outcome.attempt?.id)?.status).toBe("TIMED_OUT");
  });

  it("lets the accept win when it is inside the window", async () => {
    seedRequest();
    seedThreeExperts();
    const outcome = await service.dispatchNextOffer("req_1");
    clock.advanceBy(30_000);

    const [accept, expire] = await Promise.allSettled([
      service.acceptOffer(expertActor("expA"), outcome.attempt!.id),
      service.expireOffer(outcome.attempt!.id),
    ]);

    expect(accept.status).toBe("fulfilled");
    expect(expire.status).toBe("fulfilled");
    expect(matching.attempts.find((a) => a.id === outcome.attempt?.id)?.status).toBe("ACCEPTED");
  });
});

// ── Requirement 5: controlled relaxation ─────────────────────────────────────

describe("requirement 11 — relaxation, floored", () => {
  it("waits for the schedule rather than relaxing the moment the pool is dry", async () => {
    seedRequest();
    candidates.rows = [candidateRow({ id: "mid", skills: { apex: ["INTERMEDIATE", 4] } })];
    matching.seedAvailability("mid", "AVAILABLE");

    // No time has passed, so level 0's ADVANCED floor still applies.
    const outcome = await service.dispatchNextOffer("req_1");
    expect(outcome.action).toBe("RELAXED");
    expect(requests.rows.get("req_1")?.state).toBe("SEARCHING");
    expect(scheduler.jobs.some((j) => j.singletonKey?.startsWith("dispatch:req_1:level:"))).toBe(
      true,
    );
  });

  it("admits an INTERMEDIATE expert once level 2 is due", async () => {
    seedRequest();
    candidates.rows = [candidateRow({ id: "mid", skills: { apex: ["INTERMEDIATE", 4] } })];
    matching.seedAvailability("mid", "AVAILABLE");

    clock.advanceBy(9 * 60_000);
    const outcome = await service.dispatchNextOffer("req_1");
    expect(outcome.action).toBe("OFFERED");
    expect(outcome.attempt?.expertProfileId).toBe("mid");
    expect(outcome.relaxationLevel).toBe(2);
  });

  it("never admits a BEGINNER, at any level, and says NO_EXPERT_FOUND instead", async () => {
    // "A wrong expert is worse than no expert", as a test.
    seedRequest();
    candidates.rows = [
      candidateRow({ id: "novice", skills: { apex: ["BEGINNER", 1] }, idleMinutes: 999 }),
    ];
    matching.seedAvailability("novice", "AVAILABLE");
    clock.advanceBy(13 * 60_000);

    const outcome = await service.dispatchNextOffer("req_1");
    expect(outcome.action).toBe("NO_EXPERT_FOUND");
    expect(requests.rows.get("req_1")?.state).toBe("NO_EXPERT_FOUND");

    const excluded = matching.attempts.filter((a) => a.status === "EXCLUDED");
    expect(excluded.every((a) => a.exclusionReasons.includes("PRIMARY_BELOW_FLOOR"))).toBe(true);
  });

  it("records a run per relaxation level, with its own snapshot", async () => {
    seedRequest();
    candidates.rows = [candidateRow({ id: "mid", skills: { apex: ["INTERMEDIATE", 4] } })];
    matching.seedAvailability("mid", "AVAILABLE");
    clock.advanceBy(9 * 60_000);

    await service.dispatchNextOffer("req_1");
    const runs = matching.runs.filter((r) => r.supportRequestId === "req_1");
    expect(runs.map((r) => r.relaxationLevel)).toEqual([0, 1, 2]);
    expect(runs.map((r) => r.roundNumber)).toEqual([1, 2, 3]);
  });

  it("re-ranks at each level, so an expert who came online mid-search is picked up", async () => {
    seedRequest();
    candidates.rows = [candidateRow({ id: "mid", skills: { apex: ["INTERMEDIATE", 4] } })];
    matching.seedAvailability("mid", "AVAILABLE");
    await service.dispatchNextOffer("req_1");

    // Someone strong appears while we were waiting for the schedule.
    candidates.rows.push(candidateRow({ id: "late", skills: { apex: ["EXPERT", 9] } }));
    matching.seedAvailability("late", "AVAILABLE");
    clock.advanceBy(5 * 60_000);

    const outcome = await service.dispatchNextOffer("req_1");
    expect(outcome.attempt?.expertProfileId).toBe("late");
  });
});

// ── Requirement 14: becoming ineligible mid-dispatch ─────────────────────────

describe("requirement 14 — experts who become ineligible", () => {
  it("skips an expert who went offline between ranking and offering", async () => {
    seedRequest();
    seedThreeExperts();
    // Rank everyone, then take the winner offline before the offer is written.
    matching.seedAvailability("expA", "OFFLINE");

    const outcome = await service.dispatchNextOffer("req_1");
    expect(outcome.action).toBe("OFFERED");
    expect(outcome.attempt?.expertProfileId).toBe("expB");
    expect(matching.attempts.find((a) => a.expertProfileId === "expA")?.status).toBe("WITHDRAWN");
  });

  it("withdraws an open offer from an expert who was suspended, and re-dispatches", async () => {
    seedRequest();
    seedThreeExperts();
    const outcome = await service.dispatchNextOffer("req_1");

    matching.reconciliationQueue = [
      {
        attempt: matching.attempts.find((a) => a.id === outcome.attempt?.id)!,
        expertStatus: "SUSPENDED",
        accountStatus: "ACTIVE",
        availabilityStatus: "ON_OFFER",
        lastHeartbeatAt: T0,
      },
    ];

    const result = await service.reconcileStaleOffers();
    expect(result.withdrawn).toBe(1);
    const attempt = matching.attempts.find((a) => a.id === outcome.attempt?.id);
    expect(attempt?.status).toBe("WITHDRAWN");
    // Being suspended is not declining. Their acceptance rate is untouched.
    expect(matching.reliabilityHits).not.toContain(attempt?.id);
    expect(matching.availability.get("expA")).toBe("OFFLINE");
    // And the request is not left stranded holding an offer nobody will answer.
    expect(requests.rows.get("req_1")?.state).toBe("SEARCHING");
    expect(scheduler.jobs.some((j) => j.queue === QUEUES.dispatchNextOffer)).toBe(true);
  });

  it("gives up rather than stranding the request when reconciliation empties the pool", async () => {
    seedRequest();
    candidates.rows = [candidateRow({ id: "only", skills: { apex: ["EXPERT", 9] } })];
    matching.seedAvailability("only", "AVAILABLE");
    clock.advanceBy(13 * 60_000);
    const outcome = await service.dispatchNextOffer("req_1");

    matching.reconciliationQueue = [
      {
        attempt: matching.attempts.find((a) => a.id === outcome.attempt?.id)!,
        expertStatus: "APPROVED",
        accountStatus: "ACTIVE",
        availabilityStatus: "ON_OFFER",
        lastHeartbeatAt: new Date(T0.getTime() - 10 * 60_000),
      },
    ];
    await service.reconcileStaleOffers();
    await service.dispatchNextOffer("req_1");

    expect(requests.rows.get("req_1")?.state).toBe("NO_EXPERT_FOUND");
  });

  it("does nothing when there is nothing to reconcile", async () => {
    seedRequest();
    seedThreeExperts();
    await service.dispatchNextOffer("req_1");
    expect((await service.reconcileStaleOffers()).withdrawn).toBe(0);
  });
});

// ── Requirements 12 and 13: manual dispatch ──────────────────────────────────

describe("requirement 12 — admin Assign", () => {
  it("offers to the chosen expert and still requires their acceptance", async () => {
    seedRequest();
    seedThreeExperts();

    const attempt = await service.adminAssign(admin, {
      supportRequestId: "req_1",
      expertProfileId: "expC",
      reason: "Customer asked for the expert they worked with last week.",
    });

    // Offered, not accepted. Consent is not the admin's to give.
    expect(attempt.status).toBe("OFFERED");
    expect(attempt.origin).toBe("ADMIN_ASSIGN");
    expect(requests.rows.get("req_1")?.state).toBe("OFFERED");
    expect(requests.rows.get("req_1")?.assignedExpertId).toBeNull();

    const accepted = await service.acceptOffer(expertActor("expC"), attempt.id);
    expect(accepted.status).toBe("ACCEPTED");
    expect(requests.rows.get("req_1")?.assignedExpertId).toBe("expC");
  });

  it("lets the chosen expert decline, like any other offer", async () => {
    seedRequest();
    seedThreeExperts();
    const attempt = await service.adminAssign(admin, {
      supportRequestId: "req_1",
      expertProfileId: "expC",
      reason: "Operator judgement.",
    });

    const declined = await service.declineOffer(expertActor("expC"), attempt.id, {
      reason: "NO_LONGER_AVAILABLE",
    });
    expect(declined.status).toBe("DECLINED");
    expect(requests.rows.get("req_1")?.state).toBe("SEARCHING");
  });

  it("requires a reason", async () => {
    seedRequest();
    seedThreeExperts();
    await expect(
      service.adminAssign(admin, {
        supportRequestId: "req_1",
        expertProfileId: "expC",
        reason: "   ",
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("refuses a non-admin", async () => {
    seedRequest();
    seedThreeExperts();
    await expect(
      service.adminAssign(expertActor("expA"), {
        supportRequestId: "req_1",
        expertProfileId: "expC",
        reason: "me",
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("supersedes a live offer rather than racing it, and blames nobody", async () => {
    seedRequest();
    seedThreeExperts();
    const algorithmic = await service.dispatchNextOffer("req_1");

    const manual = await service.adminAssign(admin, {
      supportRequestId: "req_1",
      expertProfileId: "expC",
      reason: "Escalating to our Copado specialist.",
    });

    const superseded = matching.attempts.find((a) => a.id === algorithmic.attempt?.id);
    expect(superseded?.status).toBe("SUPERSEDED");
    expect(matching.reliabilityHits).not.toContain(superseded?.id);
    expect(manual.status).toBe("OFFERED");
    expect(matching.availability.get("expA")).toBe("AVAILABLE");
  });

  it("refuses to assign an expert who already holds an offer elsewhere", async () => {
    seedRequest();
    seedRequest({ id: "req_2", customerId: "cust_2" });
    seedThreeExperts();
    await service.dispatchNextOffer("req_2");

    await expect(
      service.adminAssign(admin, {
        supportRequestId: "req_1",
        expertProfileId: "expA",
        reason: "double booking attempt",
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("refuses once the request has been accepted", async () => {
    seedRequest({ state: "ACCEPTED" });
    await expect(
      service.adminAssign(admin, {
        supportRequestId: "req_1",
        expertProfileId: "expC",
        reason: "too late",
      }),
    ).rejects.toThrow(/ACCEPTED/);
  });
});

describe("requirement 12 — admin Force Assign", () => {
  it("overrides the competence rules but not consent", async () => {
    seedRequest();
    // Deliberately unqualified: BEGINNER at the primary skill, so the algorithm
    // would never reach them at any relaxation level.
    candidates.rows = [candidateRow({ id: "novice", skills: { apex: ["BEGINNER", 1] } })];
    matching.seedAvailability("novice", "AVAILABLE");

    const attempt = await service.adminForceAssign(admin, {
      supportRequestId: "req_1",
      expertProfileId: "novice",
      reason: "Spoke to them directly; they have handled this exact org before.",
    });

    expect(attempt.origin).toBe("ADMIN_FORCE_ASSIGN");
    expect(attempt.status).toBe("OFFERED");
    // §C5 originally sent force-assign straight to ACCEPTED. The user overruled
    // that, and this is the test that keeps it overruled.
    expect(requests.rows.get("req_1")?.state).toBe("OFFERED");
    expect(requests.rows.get("req_1")?.assignedExpertId).toBeNull();
  });

  it("can reach an OFFLINE expert the dispatcher never could", async () => {
    seedRequest();
    matching.seedAvailability("reached", "OFFLINE");

    const attempt = await service.adminForceAssign(admin, {
      supportRequestId: "req_1",
      expertProfileId: "reached",
      reason: "Called them; they are opening the dashboard now.",
    });
    expect(attempt.status).toBe("OFFERED");
    expect(matching.availability.get("reached")).toBe("ON_OFFER");
  });

  it("lets even a force-assigned expert decline", async () => {
    seedRequest();
    matching.seedAvailability("novice", "AVAILABLE");
    const attempt = await service.adminForceAssign(admin, {
      supportRequestId: "req_1",
      expertProfileId: "novice",
      reason: "operator override",
    });

    const declined = await service.declineOffer(expertActor("novice"), attempt.id, {
      reason: "NOT_MY_EXPERTISE",
    });
    expect(declined.status).toBe("DECLINED");
  });

  it("requires a reason", async () => {
    seedRequest();
    await expect(
      service.adminForceAssign(admin, {
        supportRequestId: "req_1",
        expertProfileId: "novice",
        reason: "",
      }),
    ).rejects.toThrow(ValidationError);
  });
});

describe("requirement 13 — manual and algorithmic are distinguishable forever", () => {
  it("stamps the origin on the attempt", async () => {
    seedRequest();
    seedThreeExperts();
    await service.dispatchNextOffer("req_1");
    const algorithmic = matching.attempts.find((a) => a.status === "OFFERED");
    expect(algorithmic?.origin).toBe("ALGORITHMIC");
    expect(algorithmic?.adminReason).toBeNull();
    expect(algorithmic?.rank).toBe(1);

    await service.adminAssign(admin, {
      supportRequestId: "req_1",
      expertProfileId: "expC",
      reason: "operator judgement",
    });
    const manual = matching.attempts.find((a) => a.origin === "ADMIN_ASSIGN");
    expect(manual?.adminReason).toBe("operator judgement");
    // No rank: it bypassed the ranking by definition.
    expect(manual?.rank).toBeNull();
  });

  it("writes an audit row naming the admin, the reason, and the consent rule", async () => {
    seedRequest();
    seedThreeExperts();
    await service.adminForceAssign(admin, {
      supportRequestId: "req_1",
      expertProfileId: "expC",
      reason: "Reached them out-of-band.",
    });

    const entries = await uow.auditLog.listForEntity({
      entityType: "SupportRequest",
      entityId: "req_1",
      limit: 50,
    });
    const entry = entries.find((e) => e.action === "matching.force_assigned");
    expect(entry).toBeDefined();
    expect(entry?.actorUserId).toBe("admin_1");
    expect(entry?.actorType).toBe("ADMIN");
    const after = entry?.after as Record<string, unknown>;
    expect(after.reason).toBe("Reached them out-of-band.");
    expect(after.origin).toBe("ADMIN_FORCE_ASSIGN");
    expect(String(after.note)).toMatch(/does not bypass consent/);
  });

  it("uses distinct audit actions for assign and force-assign", async () => {
    seedRequest();
    seedRequest({ id: "req_2", customerId: "cust_2" });
    seedThreeExperts();

    await service.adminAssign(admin, {
      supportRequestId: "req_1",
      expertProfileId: "expA",
      reason: "a",
    });
    await service.adminForceAssign(admin, {
      supportRequestId: "req_2",
      expertProfileId: "expB",
      reason: "b",
    });

    const one = await uow.auditLog.listForEntity({
      entityType: "SupportRequest",
      entityId: "req_1",
      limit: 50,
    });
    const two = await uow.auditLog.listForEntity({
      entityType: "SupportRequest",
      entityId: "req_2",
      limit: 50,
    });
    expect(one.map((e) => e.action)).toContain("matching.assigned");
    expect(two.map((e) => e.action)).toContain("matching.force_assigned");
  });
});
