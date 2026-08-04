import { beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../authorization/index.js";
import { FixedClock } from "../ports/clock.js";
import type { RealtimeBus, RealtimeChannel, RealtimeEvent } from "../ports/realtime.js";
import type { SupportRequestRecord } from "../ports/request-repositories.js";
import { InMemoryUnitOfWork } from "../experts/in-memory-uow.js";
import {
  FakeRequestRepository,
  FakeScheduler,
  SilentLogger,
} from "../support-requests/in-memory-request-world.js";
import { DISPATCH_EVENTS, DispatchNotifier, TIMING_POINTS } from "./dispatch-events.js";
import {
  candidateRow,
  FakeCandidateRepository,
  FakeMatchingRepository,
  resetMatchingIds,
} from "./in-memory-matching-world.js";
import { MatchingService } from "./matching-service.js";

/**
 * The realtime contract (§17, requirements 1–3, 10, 12, 15).
 *
 * Most of what this phase promises is a property of the *message shape* rather
 * than of any logic: if a signal carries no state, then it cannot be a source of
 * truth, cannot be applied twice, and cannot leak. So these tests assert the
 * shape, and assert that dispatch is indifferent to the transport working at all.
 */

const T0 = new Date("2026-08-03T12:00:00Z");

/** Records everything published, and can be told to fail. */
class RecordingBus implements RealtimeBus {
  readonly name = "recording";
  readonly published: Array<{ channel: RealtimeChannel; event: RealtimeEvent }> = [];
  failing = false;

  async publish(channel: RealtimeChannel, event: RealtimeEvent): Promise<void> {
    if (this.failing) throw new Error("realtime provider is down");
    this.published.push({ channel, event });
  }

  async issueClientToken(): Promise<string> {
    return "";
  }

  typesOn(kind: RealtimeChannel["kind"]): string[] {
    return this.published.filter((p) => p.channel.kind === kind).map((p) => p.event.type);
  }
}

let clock: FixedClock;
let bus: RecordingBus;
let logger: SilentLogger;
let requests: FakeRequestRepository;
let matching: FakeMatchingRepository;
let candidates: FakeCandidateRepository;
let scheduler: FakeScheduler;
let uow: InMemoryUnitOfWork;
let notifier: DispatchNotifier;
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
    matchDeadlineAt: new Date(T0.getTime() + 15 * 60_000),
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
    expert: { profileId, status: "APPROVED" },
  };
}

function seedExperts(): void {
  candidates.rows = [
    candidateRow({ id: "expA", skills: { apex: ["EXPERT", 8] }, idleMinutes: 240 }),
    candidateRow({ id: "expB", skills: { apex: ["EXPERT", 8] }, idleMinutes: 120 }),
  ];
  matching.seedAvailability("expA", "AVAILABLE");
  matching.seedAvailability("expB", "AVAILABLE");
}

function build(options: { withNotifier: boolean } = { withNotifier: true }): void {
  service = new MatchingService({
    requests,
    matching,
    candidates,
    auditLog: uow.auditLog,
    scheduler,
    clock,
    logger,
    queues: QUEUES,
    ...(options.withNotifier ? { notifier } : {}),
  });
}

beforeEach(() => {
  resetMatchingIds();
  clock = new FixedClock(T0);
  bus = new RecordingBus();
  logger = new SilentLogger();
  requests = new FakeRequestRepository();
  matching = new FakeMatchingRepository();
  candidates = new FakeCandidateRepository();
  scheduler = new FakeScheduler();
  uow = new InMemoryUnitOfWork();
  notifier = new DispatchNotifier({ realtime: bus, clock, logger });
  build();
});

// ── Requirements 1, 3 and 12: the shape is the guarantee ─────────────────────

describe("a signal carries no state (requirements 1, 3, 12)", () => {
  it("publishes an empty payload on every event", async () => {
    seedRequest();
    seedExperts();
    await service.dispatchNextOffer("req_1");

    expect(bus.published.length).toBeGreaterThan(0);
    for (const { event } of bus.published) {
      // The whole design rests on this. If a payload ever appears here, a client
      // can start trusting it, and requirements 1, 2, 3 and 12 all become
      // matters of discipline rather than of shape.
      expect(event.payload).toEqual({});
    }
  });

  it("never puts a score, a rank, or another expert's identity on the wire", async () => {
    seedRequest();
    seedExperts();
    await service.dispatchNextOffer("req_1");

    const wire = JSON.stringify(bus.published);
    for (const forbidden of ["score", "rank", "finalScore", "expB", "exclusion", "breakdown"]) {
      expect(wire.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("never puts the customer's problem text on the wire", async () => {
    seedRequest();
    seedExperts();
    await service.dispatchNextOffer("req_1");
    expect(JSON.stringify(bus.published)).not.toContain("SOQL");
  });

  it("addresses the expert and the customer on separate channels", async () => {
    seedRequest();
    seedExperts();
    await service.dispatchNextOffer("req_1");

    expect(bus.typesOn("expert")).toContain(DISPATCH_EVENTS.OFFER_OPENED);
    expect(bus.typesOn("customer")).toContain(DISPATCH_EVENTS.REQUEST_STATE_CHANGED);
    // The expert's channel never carries a request event and vice versa, so a
    // subscriber to one learns nothing about the other (requirement 11's
    // server-side half).
    expect(bus.typesOn("expert")).not.toContain(DISPATCH_EVENTS.REQUEST_STATE_CHANGED);
    expect(bus.typesOn("customer")).not.toContain(DISPATCH_EVENTS.OFFER_OPENED);
  });

  it("addresses the customer by their own id, not by a list of their requests", async () => {
    // The bug the end-to-end run found: a channel set computed from rows goes
    // stale the moment a new row appears. An identity-derived channel cannot.
    seedRequest();
    seedExperts();
    await service.dispatchNextOffer("req_1");

    const customerChannels = bus.published
      .filter((p) => p.channel.kind === "customer")
      .map((p) => (p.channel as { customerId: string }).customerId);
    expect(new Set(customerChannels)).toEqual(new Set(["cust_1"]));
  });

  it("signals only the expert who holds the offer", async () => {
    seedRequest();
    seedExperts();
    const outcome = await service.dispatchNextOffer("req_1");

    const expertChannels = bus.published
      .filter((p) => p.channel.kind === "expert")
      .map((p) => (p.channel as { expertId: string }).expertId);
    expect(new Set(expertChannels)).toEqual(new Set([outcome.attempt?.expertProfileId]));
    expect(expertChannels).not.toContain("expB");
  });
});

// ── Requirement 5: the customer sees every transition ────────────────────────

describe("the customer's channel follows the whole search (requirement 5)", () => {
  it("signals when the search begins, even before any offer", async () => {
    seedRequest();
    // Nobody qualifies, so no offer will be made — the customer must still learn
    // that we started looking.
    candidates.rows = [candidateRow({ id: "wrong", skills: { flow: ["EXPERT", 9] } })];

    await service.beginSearch("req_1");
    expect(bus.typesOn("customer")).toContain(DISPATCH_EVENTS.REQUEST_STATE_CHANGED);
  });

  it("signals on OFFERED, back to SEARCHING, and on ACCEPTED", async () => {
    seedRequest();
    seedExperts();

    const first = await service.dispatchNextOffer("req_1");
    const afterOffer = bus.typesOn("customer").length;

    await service.declineOffer(expertActor("expA"), first.attempt!.id);
    const afterDecline = bus.typesOn("customer").length;
    expect(afterDecline).toBeGreaterThan(afterOffer);

    const second = await service.dispatchNextOffer("req_1");
    await service.acceptOffer(expertActor("expB"), second.attempt!.id);
    expect(bus.typesOn("customer").length).toBeGreaterThan(afterDecline);
  });

  it("signals NO_EXPERT_FOUND, so the customer is not left on a spinner", async () => {
    seedRequest();
    candidates.rows = [candidateRow({ id: "wrong", skills: { flow: ["EXPERT", 9] } })];
    clock.advanceBy(7 * 60_000); // past the level-3 schedule

    await service.dispatchNextOffer("req_1");
    expect(requests.rows.get("req_1")?.state).toBe("NO_EXPERT_FOUND");
    expect(bus.typesOn("customer")).toContain(DISPATCH_EVENTS.REQUEST_STATE_CHANGED);
  });

  it("signals the expert that their offer closed, so the card goes away", async () => {
    seedRequest();
    seedExperts();
    const outcome = await service.dispatchNextOffer("req_1");
    clock.advanceBy(61_000);
    await service.expireOffer(outcome.attempt!.id);

    expect(bus.typesOn("expert")).toContain(DISPATCH_EVENTS.OFFER_CLOSED);
  });
});

// ── Requirement 2: idempotence ───────────────────────────────────────────────

describe("idempotence (requirement 2)", () => {
  it("publishing the same signal twice is indistinguishable from once", async () => {
    // The property that makes replay safe: the message has no identity and no
    // content, so two of them and one of them mean the same thing.
    await notifier.offerOpened({
      expertProfileId: "expA",
      supportRequestId: "req_1",
      customerId: "cust_1",
      offeredAt: T0,
    });
    const first = JSON.stringify(bus.published);

    bus.published.length = 0;
    await notifier.offerOpened({
      expertProfileId: "expA",
      supportRequestId: "req_1",
      customerId: "cust_1",
      offeredAt: T0,
    });
    await notifier.offerOpened({
      expertProfileId: "expA",
      supportRequestId: "req_1",
      customerId: "cust_1",
      offeredAt: T0,
    });

    // Two publishes produce two identical *sets* of messages, and a client that
    // fetches on each performs one extra GET and reaches the same state.
    const perPublish = JSON.parse(first).length as number;
    const second = JSON.parse(JSON.stringify(bus.published)) as unknown[];
    expect(second).toHaveLength(perPublish * 2);
    expect(JSON.stringify(second.slice(0, perPublish))).toBe(first);
    expect(JSON.stringify(second.slice(perPublish))).toBe(first);
  });

  it("a duplicated dispatch does not produce a second offer or a second signal set", async () => {
    seedRequest();
    seedExperts();
    await service.dispatchNextOffer("req_1");
    const afterFirst = bus.published.length;

    // Exactly what a redelivered pg-boss job does.
    const again = await service.dispatchNextOffer("req_1");
    expect(again.action).toBe("ALREADY_OFFERED");
    expect(bus.published.length).toBe(afterFirst);
  });
});

// ── Requirement 10: dispatch does not depend on delivery ─────────────────────

describe("notification failure never affects dispatch (requirement 10)", () => {
  it("still creates and persists the offer when the provider throws", async () => {
    seedRequest();
    seedExperts();
    bus.failing = true;

    const outcome = await service.dispatchNextOffer("req_1");

    expect(outcome.action).toBe("OFFERED");
    expect(outcome.attempt?.status).toBe("OFFERED");
    // Still a real, answerable offer with its stored deadline.
    expect(outcome.attempt?.offerExpiresAt).toEqual(new Date(T0.getTime() + 60_000));
    expect(requests.rows.get("req_1")?.state).toBe("OFFERED");
    expect(bus.published).toHaveLength(0);
  });

  it("still accepts, declines and times out when the provider throws", async () => {
    seedRequest();
    seedExperts();
    bus.failing = true;

    const first = await service.dispatchNextOffer("req_1");
    await service.declineOffer(expertActor("expA"), first.attempt!.id);
    expect(requests.rows.get("req_1")?.state).toBe("SEARCHING");

    const second = await service.dispatchNextOffer("req_1");
    await service.acceptOffer(expertActor("expB"), second.attempt!.id);
    expect(requests.rows.get("req_1")?.state).toBe("ACCEPTED");
  });

  it("works identically with no notifier configured at all", async () => {
    // The strongest form of requirement 10: realtime removed entirely, and the
    // Phase 5 behaviour is unchanged.
    build({ withNotifier: false });
    seedRequest();
    seedExperts();

    const outcome = await service.dispatchNextOffer("req_1");
    expect(outcome.action).toBe("OFFERED");
    clock.advanceBy(61_000);
    expect((await service.expireOffer(outcome.attempt!.id)).expired).toBe(true);
    expect(requests.rows.get("req_1")?.state).toBe("SEARCHING");
  });

  it("logs the failure rather than swallowing it silently", async () => {
    seedRequest();
    seedExperts();
    bus.failing = true;
    await service.dispatchNextOffer("req_1");

    // Degrading quietly is fine for the expert and unacceptable for an operator.
    expect(
      logger.lines.some(
        (line) => line.level === "warn" && line.message.includes("realtime publish failed"),
      ),
    ).toBe(true);
  });
});

// ── Requirement 15: a signal cannot move the deadline ────────────────────────

describe("the offer window is untouched by realtime (requirement 15)", () => {
  it("keeps offerExpiresAt fixed across any number of signals", async () => {
    seedRequest();
    seedExperts();
    const outcome = await service.dispatchNextOffer("req_1");
    const expiry = outcome.attempt?.offerExpiresAt;

    clock.advanceBy(20_000);
    for (let i = 0; i < 5; i++) {
      await notifier.offerOpened({
        expertProfileId: "expA",
        supportRequestId: "req_1",
        customerId: "cust_1",
        offeredAt: T0,
      });
    }

    expect(matching.attempts.find((a) => a.id === outcome.attempt?.id)?.offerExpiresAt).toEqual(
      expiry,
    );
  });
});

// ── Requirement 16: the timing points exist and are greppable ────────────────

describe("timing instrumentation (requirement 16)", () => {
  it("records the run, the persisted offer, and the publish", async () => {
    seedRequest();
    seedExperts();
    await service.dispatchNextOffer("req_1");

    const points = logger.lines
      .filter((line) => line.message.startsWith("latency "))
      .map((line) => line.message.replace("latency ", ""));

    expect(points).toContain(TIMING_POINTS.MATCHING_RUN_STARTED);
    expect(points).toContain(TIMING_POINTS.OFFER_PERSISTED);
    expect(points).toContain(TIMING_POINTS.REALTIME_PUBLISHED);
  });

  it("records the accept, with the human's actual response time", async () => {
    seedRequest();
    seedExperts();
    const outcome = await service.dispatchNextOffer("req_1");
    clock.advanceBy(9_000);
    await service.acceptOffer(expertActor("expA"), outcome.attempt!.id);

    expect(
      logger.lines.some((line) => line.message === `latency ${TIMING_POINTS.EXPERT_ACCEPTED}`),
    ).toBe(true);
  });

  it("uses one greppable prefix for every point", async () => {
    seedRequest();
    seedExperts();
    await service.dispatchNextOffer("req_1");
    const timingLines = logger.lines.filter((line) => line.message.startsWith("latency "));
    expect(timingLines.length).toBeGreaterThanOrEqual(3);
  });
});
