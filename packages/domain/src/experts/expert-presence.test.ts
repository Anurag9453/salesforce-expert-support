import type { ExpertStatus } from "@sfx/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../authorization/index.js";
import { FixedClock } from "../ports/clock.js";
import { ConflictError, ForbiddenError } from "../shared/errors.js";
import { ExpertAvailabilityService } from "./expert-availability-service.js";
import { FakeAvailabilityRepository, RecordingLogger } from "./in-memory-expert-world.js";

/**
 * The Phase 4 exit criterion, as tests:
 *
 *   APPROVED → AVAILABLE → heartbeat fresh → stop → swept OFFLINE →
 *   heartbeat resumes → STILL OFFLINE → explicit toggle → AVAILABLE
 *
 * The middle step is the one that matters. A heartbeat arriving after a sweep
 * must not resurrect the expert (requirement 5).
 */

const STALE_AFTER = 180;

let repo: FakeAvailabilityRepository;
let clock: FixedClock;
let logger: RecordingLogger;
let service: ExpertAvailabilityService;

function actor(status: ExpertStatus = "APPROVED", overrides: Partial<Actor> = {}): Actor {
  return {
    userId: "user_1",
    email: "e@example.com",
    roles: ["CUSTOMER", "EXPERT"],
    status: "ACTIVE",
    expert: { profileId: "exp_1", status },
    ...overrides,
  };
}

beforeEach(() => {
  repo = new FakeAvailabilityRepository();
  clock = new FixedClock(new Date("2026-08-02T12:00:00Z"));
  logger = new RecordingLogger();
  repo.seed({ expertProfileId: "exp_1", userId: "user_1" });
  service = new ExpertAvailabilityService({
    availability: repo,
    clock,
    logger,
    heartbeatStaleAfterSeconds: STALE_AFTER,
  });
});

describe("the full presence lifecycle", () => {
  it("runs approved → available → swept → still offline → available again", async () => {
    // 1. Approved and offline: not eligible.
    const initial = await service.getOwn(actor());
    expect(initial.availabilityStatus).toBe("OFFLINE");
    expect(initial.eligibility.eligible).toBe(false);
    expect(initial.eligibility.reasons).toContain("NOT_AVAILABLE");

    // 2. Going available is immediately effective — the toggle seeds the
    //    heartbeat so there is no dead window before the first ping.
    const online = await service.setAvailability(actor(), true);
    expect(online.availabilityStatus).toBe("AVAILABLE");
    expect(online.eligibility.eligible).toBe(true);
    expect(online.secondsSinceHeartbeat).toBe(0);

    // 3. Heartbeats keep it fresh.
    clock.advanceBy(60_000);
    const beating = await service.heartbeat(actor());
    expect(beating.eligibility.eligible).toBe(true);

    // 4. The browser closes. Nothing arrives for longer than the window.
    clock.advanceBy((STALE_AFTER + 30) * 1000);
    const beforeSweep = await service.getOwn(actor());
    // Still AVAILABLE by status, but already not matchable — presence is stale.
    expect(beforeSweep.availabilityStatus).toBe("AVAILABLE");
    expect(beforeSweep.eligibility.eligible).toBe(false);
    expect(beforeSweep.eligibility.reasons).toContain("PRESENCE_STALE");

    const swept = await service.sweepStalePresence();
    expect(swept.swept).toBe(1);

    const afterSweep = await service.getOwn(actor());
    expect(afterSweep.availabilityStatus).toBe("OFFLINE");

    // 5. Requirement 5 — the tab is reopened and heartbeats resume. This must
    //    NOT bring them back.
    clock.advanceBy(5_000);
    const resumed = await service.heartbeat(actor());
    expect(resumed.availabilityStatus).toBe("OFFLINE");
    expect(resumed.eligibility.eligible).toBe(false);
    expect(resumed.eligibility.reasons).toContain("NOT_AVAILABLE");

    // Even many heartbeats later.
    for (let i = 0; i < 5; i++) {
      clock.advanceBy(45_000);
      await service.heartbeat(actor());
    }
    expect((await service.getOwn(actor())).availabilityStatus).toBe("OFFLINE");

    // 6. Only an explicit choice restores it.
    const backOnline = await service.setAvailability(actor(), true);
    expect(backOnline.availabilityStatus).toBe("AVAILABLE");
    expect(backOnline.eligibility.eligible).toBe(true);
  });

  it("records the sweep in the availability history with its cause", async () => {
    await service.setAvailability(actor(), true);
    clock.advanceBy((STALE_AFTER + 1) * 1000);
    await service.sweepStalePresence();

    const history = await service.history(actor());
    expect(history[0]?.toStatus).toBe("OFFLINE");
    expect(history[0]?.source).toBe("HEARTBEAT_TIMEOUT");
    // System action, so no user attributed to it.
    expect(history[0]?.changedByUserId).toBeNull();
    expect(history[1]?.toStatus).toBe("AVAILABLE");
    expect(history[1]?.source).toBe("MANUAL_TOGGLE");
    expect(history[1]?.changedByUserId).toBe("user_1");
  });
});

describe("requirement 3 — the availability API refuses unapproved experts", () => {
  const blocked: ExpertStatus[] = ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "REJECTED", "SUSPENDED"];

  for (const status of blocked) {
    it(`refuses a ${status} expert going available`, async () => {
      await expect(service.setAvailability(actor(status), true)).rejects.toThrow(ForbiddenError);
      expect(repo.presence.get("exp_1")?.availabilityStatus).toBe("OFFLINE");
    });
  }

  it("allows an APPROVED expert", async () => {
    await expect(service.setAvailability(actor("APPROVED"), true)).resolves.toMatchObject({
      availabilityStatus: "AVAILABLE",
    });
  });

  it("lets any expert go OFFLINE regardless of status", async () => {
    // Turning yourself off is never something to block; a suspended expert
    // should not be stuck showing as available.
    await service.setAvailability(actor("APPROVED"), true);
    await expect(service.setAvailability(actor("SUSPENDED"), false)).resolves.toMatchObject({
      availabilityStatus: "OFFLINE",
    });
  });

  it("blocks a suspended expert from going available again after being online", async () => {
    await service.setAvailability(actor("APPROVED"), true);
    await service.setAvailability(actor("APPROVED"), false);
    await expect(service.setAvailability(actor("SUSPENDED"), true)).rejects.toThrow(ForbiddenError);
  });
});

describe("the toggle", () => {
  it("is idempotent", async () => {
    await service.setAvailability(actor(), true);
    const again = await service.setAvailability(actor(), true);
    expect(again.availabilityStatus).toBe("AVAILABLE");
    // No spurious second log entry — history should read as what happened.
    expect(repo.log.filter((entry) => entry.toStatus === "AVAILABLE")).toHaveLength(1);
  });

  it("explains, in human terms, why you cannot go offline mid-offer", async () => {
    // Going offline must not be an escape hatch from a request already sent.
    // The expert deserves a message they can act on, not a state-machine error.
    await service.setAvailability(actor(), true);
    repo.presence.set("exp_1", {
      ...repo.presence.get("exp_1")!,
      availabilityStatus: "ON_OFFER",
    });

    await expect(service.setAvailability(actor(), false)).rejects.toThrow(ConflictError);
    await expect(service.setAvailability(actor(), false)).rejects.toThrow(/waiting on your answer/);
  });

  it("explains why you cannot go offline mid-session", async () => {
    await service.setAvailability(actor(), true);
    repo.presence.set("exp_1", {
      ...repo.presence.get("exp_1")!,
      availabilityStatus: "IN_SESSION",
    });
    await expect(service.setAvailability(actor(), false)).rejects.toThrow(/in a session/);
  });

  it("reports a conflict when the write loses an optimistic race", async () => {
    // The row moved between read and write in a way that is still a legal
    // transition — the guard has to catch it at the write, not before.
    await service.setAvailability(actor(), true);
    const original = repo.changeStatus.bind(repo);
    repo.changeStatus = async () => null;
    try {
      await expect(service.setAvailability(actor(), false)).rejects.toThrow(ConflictError);
    } finally {
      repo.changeStatus = original;
    }
  });
});

describe("the sweep", () => {
  it("leaves a fresh expert alone", async () => {
    await service.setAvailability(actor(), true);
    clock.advanceBy(60_000);
    expect((await service.sweepStalePresence()).swept).toBe(0);
    expect(repo.presence.get("exp_1")?.availabilityStatus).toBe("AVAILABLE");
  });

  it("leaves an already-offline expert alone", async () => {
    clock.advanceBy(10 * 60_000);
    expect((await service.sweepStalePresence()).swept).toBe(0);
  });

  it("is idempotent across runs", async () => {
    await service.setAvailability(actor(), true);
    clock.advanceBy((STALE_AFTER + 1) * 1000);
    expect((await service.sweepStalePresence()).swept).toBe(1);
    expect((await service.sweepStalePresence()).swept).toBe(0);
    expect(repo.log.filter((e) => e.source === "HEARTBEAT_TIMEOUT")).toHaveLength(1);
  });

  it("sweeps several experts in one pass", async () => {
    repo.seed({ expertProfileId: "exp_2", userId: "user_2" });
    repo.presence.set("exp_1", {
      ...repo.presence.get("exp_1")!,
      availabilityStatus: "AVAILABLE",
      lastHeartbeatAt: new Date(clock.now().getTime() - 10 * 60_000),
    });
    repo.presence.set("exp_2", {
      ...repo.presence.get("exp_2")!,
      availabilityStatus: "AVAILABLE",
      lastHeartbeatAt: new Date(clock.now().getTime() - 10 * 60_000),
    });
    expect((await service.sweepStalePresence()).swept).toBe(2);
  });

  it("logs each sweep so a spike is visible", async () => {
    await service.setAvailability(actor(), true);
    clock.advanceBy((STALE_AFTER + 1) * 1000);
    await service.sweepStalePresence();
    expect(logger.lines.some((l) => l.message.includes("swept offline"))).toBe(true);
  });
});

describe("ownership", () => {
  it("refuses to read another expert's presence", async () => {
    repo.seed({ expertProfileId: "exp_2", userId: "user_2" });
    const impostor = actor("APPROVED", {
      userId: "user_1",
      expert: { profileId: "exp_2", status: "APPROVED" },
    });
    await expect(service.getOwn(impostor)).rejects.toThrow(ForbiddenError);
  });

  it("refuses a user with no expert application", async () => {
    const customer: Actor = {
      userId: "user_9",
      email: "c@example.com",
      roles: ["CUSTOMER"],
      status: "ACTIVE",
    };
    await expect(service.getOwn(customer)).rejects.toThrow(ForbiddenError);
  });
});
