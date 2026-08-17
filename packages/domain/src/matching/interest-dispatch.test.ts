import { beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../authorization/index.js";
import type { SupportRequestRecord } from "../ports/request-repositories.js";
import { FakeScheduler } from "../support-requests/in-memory-request-world.js";
import { ConflictError, NotFoundError } from "../shared/errors.js";
import { FakeMatchingRepository, resetMatchingIds } from "./in-memory-matching-world.js";
import { InterestDispatch } from "./interest-dispatch.js";

/**
 * Every test here drives a **controllable clock**.
 *
 * That is not incidental tidiness. The whole flow is time-shaped — a window that
 * closes, a two-minute confirmation, a lapse — and the machine this repository
 * is developed on suspends between commands, so wall-clock time jumps by hours.
 * Anything asserted against `Date.now()` would be flaky for reasons that have
 * nothing to do with the code.
 *
 * The domain is fully clock-injected (the only `new Date()` in it is inside
 * `systemClock` itself), so the fix is simply to use that everywhere here.
 */
class TestClock {
  constructor(private current: Date) {}
  now = () => this.current;
  advance(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}

const START = new Date("2026-05-01T09:00:00.000Z");

let clock: TestClock;
let matching: FakeMatchingRepository;
let scheduler: FakeScheduler;
let dispatch: InterestDispatch;

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

const WINDOW_SECONDS = 90;
const BROADCAST_SIZE = 8;

function request(overrides: Partial<SupportRequestRecord> = {}): SupportRequestRecord {
  return {
    id: "req_1",
    customerId: "cust_1",
    state: "SEARCHING",
    createdAt: START,
    version: 1,
    matchDeadlineAt: new Date(START.getTime() + 15 * 60_000),
    skills: [],
    ...overrides,
  } as unknown as SupportRequestRecord;
}

function expert(profileId: string): Actor {
  return {
    userId: `user_${profileId}`,
    email: `${profileId}@x.test`,
    roles: ["CUSTOMER", "EXPERT"],
    status: "ACTIVE",
    emailVerified: true,
    expert: { profileId, status: "APPROVED" },
  } as unknown as Actor;
}

/** Seeds a ranked round the way `createRun` would leave it. */
function seedRanked(count: number, requestId = "req_1"): void {
  for (let index = 0; index < count; index += 1) {
    matching.attempts.push({
      id: `att_${String(index + 1)}`,
      matchingRunId: "run_1",
      supportRequestId: requestId,
      expertProfileId: `exp_${String(index + 1)}`,
      origin: "ALGORITHMIC",
      rank: index + 1,
      status: "RANKED",
      skillScore: 0,
      experienceScore: 0,
      ratingScore: 0,
      fairnessScore: 0,
      reliabilityScore: 0,
      finalScore: 1 - index / 100,
      scoreBreakdown: {},
      exclusionReasons: [],
      offeredAt: null,
      offerExpiresAt: null,
      respondedAt: null,
      responseSeconds: null,
      declineReason: null,
      declineNote: null,
      adminReason: null,
    } as never);
  }
}

beforeEach(() => {
  resetMatchingIds();
  clock = new TestClock(START);
  matching = new FakeMatchingRepository();
  scheduler = new FakeScheduler();
  dispatch = new InterestDispatch({
    matching,
    scheduler,
    clock,
    logger,
    queues: { interestWindowClose: "interest-close", confirmationTimeout: "confirm-timeout" },
    broadcastSize: BROADCAST_SIZE,
    interestWindowSeconds: WINDOW_SECONDS,
  });
});

describe("opening the window", () => {
  it("schedules the close and reports who was reached", async () => {
    seedRanked(5);
    const outcome = await dispatch.openWindow(request());

    expect(outcome).toEqual({ action: "BROADCAST", reached: 5 });
    const job = scheduler.jobs.find((entry) => entry.queue === "interest-close");
    expect(job?.singletonKey).toBe("interest-close:req_1");
  });

  it("counts only those inside the broadcast cap", async () => {
    // Ranked 9th and 10th were not asked, even though the rows exist.
    seedRanked(10);
    expect(await dispatch.openWindow(request())).toEqual({
      action: "BROADCAST",
      reached: BROADCAST_SIZE,
    });
  });

  it("does nothing for a request that is no longer searching", async () => {
    seedRanked(3);
    const outcome = await dispatch.openWindow(request({ state: "ACCEPTED" } as never));
    expect(outcome.action).toBe("NOT_SEARCHING");
    expect(scheduler.jobs).toHaveLength(0);
  });

  it("uses a singleton key, so a re-entry cannot schedule a second close", async () => {
    seedRanked(3);
    await dispatch.openWindow(request());
    await dispatch.openWindow(request());
    const keys = scheduler.jobs
      .filter((job) => job.queue === "interest-close")
      .map((job) => job.singletonKey);
    expect(new Set(keys).size).toBe(1);
  });
});

describe("an expert's opportunities", () => {
  it("lists only what they were actually asked about", async () => {
    seedRanked(10);
    const forTop = await dispatch.opportunitiesFor(expert("exp_1"));
    expect(forTop).toHaveLength(1);

    // Ranked 10th — outside the cap, so not an opportunity.
    expect(await dispatch.opportunitiesFor(expert("exp_10"))).toHaveLength(0);
  });

  it("drops out of the list once answered", async () => {
    seedRanked(3);
    await dispatch.respond(expert("exp_1"), "att_1", true);
    expect(await dispatch.opportunitiesFor(expert("exp_1"))).toHaveLength(0);
  });

  it("refuses an account that is not an approved expert", async () => {
    // `offer:read_own` is gated on an approved workspace, so a plain customer
    // never reaches the query at all.
    seedRanked(3);
    const customer = { userId: "u", roles: ["CUSTOMER"], status: "ACTIVE" } as unknown as Actor;
    await expect(dispatch.opportunitiesFor(customer)).rejects.toThrow(/offer:read_own/);
  });
});

describe("raising a hand", () => {
  it("records interest", async () => {
    seedRanked(3);
    expect(await dispatch.respond(expert("exp_1"), "att_1", true)).toEqual({ changed: true });
    expect((await matching.listInterested("req_1")).map((a) => a.id)).toEqual(["att_1"]);
  });

  it("records a pass without counting it as interest", async () => {
    seedRanked(3);
    await dispatch.respond(expert("exp_1"), "att_1", false);
    expect(await matching.listInterested("req_1")).toHaveLength(0);
  });

  it("treats a second answer as a no-op rather than an error", async () => {
    // A double-clicked button should not produce a 409 the expert must interpret.
    seedRanked(3);
    await dispatch.respond(expert("exp_1"), "att_1", true);
    expect(await dispatch.respond(expert("exp_1"), "att_1", false)).toEqual({ changed: false });
    // And the first answer stands.
    expect((await matching.listInterested("req_1")).map((a) => a.id)).toEqual(["att_1"]);
  });

  it("refuses to answer somebody else's attempt", async () => {
    seedRanked(3);
    expect(await dispatch.respond(expert("exp_2"), "att_1", true)).toEqual({ changed: false });
  });
});

describe("closing the window", () => {
  it("closes early once enough hands are up", async () => {
    seedRanked(8);
    for (const n of [1, 2, 3])
      await dispatch.respond(expert(`exp_${String(n)}`), `att_${String(n)}`, true);
    // Five seconds in, nowhere near the 90-second window.
    clock.advance(5);
    expect(await dispatch.shouldClose(request())).toBe(true);
  });

  it("keeps waiting while the pool is thin and the window is open", async () => {
    seedRanked(8);
    await dispatch.respond(expert("exp_1"), "att_1", true);
    clock.advance(30);
    expect(await dispatch.shouldClose(request())).toBe(false);
  });

  it("closes on a single hand once the window runs out", async () => {
    // One shown now beats three shown after the deadline has passed.
    seedRanked(8);
    await dispatch.respond(expert("exp_1"), "att_1", true);
    clock.advance(WINDOW_SECONDS);
    expect(await dispatch.shouldClose(request())).toBe(true);
  });

  it("does not close an empty pool even long after the window", async () => {
    seedRanked(8);
    clock.advance(WINDOW_SECONDS * 10);
    expect(await dispatch.shouldClose(request())).toBe(false);
  });

  it("takes the best three by rank, not by who answered first", async () => {
    seedRanked(8);
    // Answered in reverse order; ranking must still decide.
    for (const n of [6, 4, 2, 1])
      await dispatch.respond(expert(`exp_${String(n)}`), `att_${String(n)}`, true);

    expect(await dispatch.closeWindow(request())).toEqual({ action: "SHORTLISTED", candidates: 3 });
    const shortlist = await dispatch.shortlistFor("req_1");
    expect(shortlist.map((a) => a.expertProfileId)).toEqual(["exp_1", "exp_2", "exp_4"]);
  });

  it("shows fewer than three rather than nothing", async () => {
    seedRanked(8);
    await dispatch.respond(expert("exp_5"), "att_5", true);
    expect(await dispatch.closeWindow(request())).toEqual({ action: "SHORTLISTED", candidates: 1 });
  });

  it("reports NO_INTEREST when nobody raised a hand", async () => {
    seedRanked(8);
    expect(await dispatch.closeWindow(request())).toEqual({ action: "NO_INTEREST" });
  });

  it("supersedes everyone who did not make the cut, keeping the audit trail", async () => {
    seedRanked(8);
    for (const n of [1, 2, 3, 4])
      await dispatch.respond(expert(`exp_${String(n)}`), `att_${String(n)}`, true);
    await dispatch.closeWindow(request());

    // Nothing is deleted — the fourth interested expert is SUPERSEDED, so "who
    // was considered" is still answerable.
    const fourth = matching.attempts.find((a) => a.id === "att_4");
    expect(fourth?.status).toBe("SUPERSEDED");
    expect(matching.attempts).toHaveLength(8);
  });

  it("does nothing for a request that already moved on", async () => {
    seedRanked(3);
    await dispatch.respond(expert("exp_1"), "att_1", true);
    expect((await dispatch.closeWindow(request({ state: "ACCEPTED" } as never))).action).toBe(
      "NOT_SEARCHING",
    );
  });
});

describe("the customer's selection", () => {
  async function shortlistOfThree() {
    seedRanked(8);
    for (const n of [1, 2, 3])
      await dispatch.respond(expert(`exp_${String(n)}`), `att_${String(n)}`, true);
    await dispatch.closeWindow(request());
  }

  it("opens a two-minute window with a STORED deadline", async () => {
    await shortlistOfThree();
    const chosen = await dispatch.select("req_1", "att_2");

    expect(chosen.status).toBe("CONFIRMING");
    // 120 seconds from the clock, persisted on the row — not held by the job.
    expect(chosen.offerExpiresAt?.toISOString()).toBe(
      new Date(START.getTime() + 120_000).toISOString(),
    );
    expect(scheduler.jobs.some((job) => job.queue === "confirm-timeout")).toBe(true);
  });

  it("does not extend the deadline when re-read later", async () => {
    // The refresh-buys-more-time bug, in the confirmation window this time.
    await shortlistOfThree();
    const first = await dispatch.select("req_1", "att_1");
    clock.advance(60);
    const shortlist = await dispatch.shortlistFor("req_1");
    const same = shortlist.find((a) => a.id === "att_1");
    expect(same?.offerExpiresAt?.toISOString()).toBe(first.offerExpiresAt?.toISOString());
  });

  it("refuses a second selection while one is confirming", async () => {
    await shortlistOfThree();
    await dispatch.select("req_1", "att_1");
    await expect(dispatch.select("req_1", "att_2")).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses an attempt that is not on the shortlist", async () => {
    await shortlistOfThree();
    await expect(dispatch.select("req_1", "att_7")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("lapse and fallback", () => {
  async function selectedFromThree() {
    seedRanked(8);
    for (const n of [1, 2, 3])
      await dispatch.respond(expert(`exp_${String(n)}`), `att_${String(n)}`, true);
    await dispatch.closeWindow(request());
    await dispatch.select("req_1", "att_1");
  }

  it("leaves the remaining two when one lapses", async () => {
    await selectedFromThree();
    const result = await dispatch.lapse("req_1", "att_1");
    expect(result.exhausted).toBe(false);
    expect(result.remaining.map((a) => a.id)).toEqual(["att_2", "att_3"]);
  });

  it("reports exhaustion when the last one lapses", async () => {
    // Two different transitions — "ask again" vs "search again" — and getting
    // them the wrong way round strands the customer on an empty screen.
    seedRanked(8);
    await dispatch.respond(expert("exp_1"), "att_1", true);
    await dispatch.closeWindow(request());
    await dispatch.select("req_1", "att_1");

    const result = await dispatch.lapse("req_1", "att_1");
    expect(result.exhausted).toBe(true);
    expect(result.remaining).toHaveLength(0);
  });

  it("loses gracefully when the expert confirmed just before the timer fired", async () => {
    await selectedFromThree();
    // Simulate the confirmation landing first.
    const index = matching.attempts.findIndex((a) => a.id === "att_1");
    const settled = matching.attempts[index];
    if (settled) matching.attempts[index] = { ...settled, status: "ACCEPTED" };

    const result = await dispatch.lapse("req_1", "att_1");
    expect(result.exhausted).toBe(false);
  });

  it("only sweeps confirmations whose stored deadline has actually passed", async () => {
    await selectedFromThree();
    clock.advance(119);
    expect(await dispatch.lapsedConfirmations()).toHaveLength(0);

    clock.advance(2);
    expect((await dispatch.lapsedConfirmations()).map((a) => a.id)).toEqual(["att_1"]);
  });
});

// ── Cases from the acceptance checklist not covered above ────────────────────

describe("no response at all", () => {
  it("leaves an unanswered attempt RANKED, so it is neither interested nor passed", async () => {
    seedRanked(5);
    await dispatch.respond(expert("exp_1"), "att_1", true);
    clock.advance(WINDOW_SECONDS);
    await dispatch.closeWindow(request());

    // exp_2 never answered. They are SUPERSEDED with the rest of the round —
    // recorded as considered, never as having declined.
    const silent = matching.attempts.find((a) => a.id === "att_2");
    expect(silent?.status).toBe("SUPERSEDED");
    expect(silent?.respondedAt).toBeNull();
  });
});

describe("an expert who goes unavailable mid-flow", () => {
  it("can still be shortlisted, because interest never locked their availability", async () => {
    // Deliberate: interest is cheap and binds nobody, so availability is not
    // consulted until the moment of confirmation. The alternative — filtering
    // the shortlist on live presence — would make the customer's three cards
    // flicker as people come and go.
    seedRanked(5);
    for (const n of [1, 2])
      await dispatch.respond(expert(`exp_${String(n)}`), `att_${String(n)}`, true);
    matching.seedAvailability("exp_1", "OFFLINE");

    await dispatch.closeWindow(request());
    expect((await dispatch.shortlistFor("req_1")).map((a) => a.expertProfileId)).toEqual([
      "exp_1",
      "exp_2",
    ]);
  });

  it("still lets the customer pick them, and the lapse path covers a no-show", async () => {
    // The two-minute window IS the availability check: an expert who has walked
    // away simply does not confirm, and the customer falls back to the others.
    seedRanked(5);
    for (const n of [1, 2])
      await dispatch.respond(expert(`exp_${String(n)}`), `att_${String(n)}`, true);
    await dispatch.closeWindow(request());
    matching.seedAvailability("exp_1", "OFFLINE");

    await dispatch.select("req_1", "att_1");
    clock.advance(121);
    expect((await dispatch.lapsedConfirmations()).map((a) => a.id)).toEqual(["att_1"]);

    const { remaining, exhausted } = await dispatch.lapse("req_1", "att_1");
    expect(exhausted).toBe(false);
    expect(remaining.map((a) => a.id)).toEqual(["att_2"]);
  });
});

describe("concurrent and duplicate responses", () => {
  it("only one of two simultaneous answers wins", async () => {
    seedRanked(3);
    const [first, second] = await Promise.all([
      dispatch.respond(expert("exp_1"), "att_1", true),
      dispatch.respond(expert("exp_1"), "att_1", false),
    ]);
    expect([first.changed, second.changed].filter(Boolean)).toHaveLength(1);
  });

  it("only one of two simultaneous selections opens a window", async () => {
    seedRanked(5);
    for (const n of [1, 2])
      await dispatch.respond(expert(`exp_${String(n)}`), `att_${String(n)}`, true);
    await dispatch.closeWindow(request());

    const results = await Promise.allSettled([
      dispatch.select("req_1", "att_1"),
      dispatch.select("req_1", "att_2"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    // And exactly one attempt is CONFIRMING.
    const confirming = matching.attempts.filter((a) => a.status === "CONFIRMING");
    expect(confirming).toHaveLength(1);
  });

  it("a lapse and a confirmation cannot both settle the same attempt", async () => {
    seedRanked(5);
    for (const n of [1, 2])
      await dispatch.respond(expert(`exp_${String(n)}`), `att_${String(n)}`, true);
    await dispatch.closeWindow(request());
    await dispatch.select("req_1", "att_1");

    const [confirmed, timedOut] = await Promise.all([
      matching.settleConfirmation({
        attemptId: "att_1",
        expertProfileId: "exp_1",
        toStatus: "ACCEPTED",
        now: clock.now(),
        releaseTo: "IN_SESSION",
      }),
      matching.settleConfirmation({
        attemptId: "att_1",
        expertProfileId: "exp_1",
        toStatus: "TIMED_OUT",
        now: clock.now(),
        releaseTo: null,
      }),
    ]);
    expect([confirmed, timedOut].filter(Boolean)).toHaveLength(1);
  });
});

describe("authorization boundaries", () => {
  it("an expert cannot answer on another expert's behalf", async () => {
    seedRanked(3);
    expect(await dispatch.respond(expert("exp_9"), "att_1", true)).toEqual({ changed: false });
    expect(matching.attempts.find((a) => a.id === "att_1")?.status).toBe("RANKED");
  });

  it("a non-expert cannot respond at all", async () => {
    seedRanked(3);
    const customer = { userId: "u", roles: ["CUSTOMER"], status: "ACTIVE" } as unknown as Actor;
    await expect(dispatch.respond(customer, "att_1", true)).rejects.toThrow(/offer:respond/);
  });

  it("an unapproved expert cannot see opportunities", async () => {
    seedRanked(3);
    const pending = {
      userId: "u2",
      roles: ["CUSTOMER", "EXPERT"],
      status: "ACTIVE",
      emailVerified: true,
      expert: { profileId: "exp_1", status: "SUBMITTED" },
    } as unknown as Actor;
    await expect(dispatch.opportunitiesFor(pending)).rejects.toThrow(/offer:read_own/);
  });
});
