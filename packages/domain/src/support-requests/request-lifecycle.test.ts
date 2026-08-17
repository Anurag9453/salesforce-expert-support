import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../authorization/index.js";
import { ClassificationService } from "../classification/classification-service.js";
import { FixedClock } from "../ports/clock.js";
import type { ProblemClassifier } from "../ports/classifier.js";
import { ConflictError, ValidationError } from "../shared/errors.js";
import { InMemoryRequestWorld } from "./in-memory-request-world.js";
import { deriveTitle, SupportRequestService } from "./request-service.js";

/**
 * The Phase 3 exit criterion, as tests: a request is created, redacted, priced,
 * authorized, classified, and reaches SEARCHING — and reaches SEARCHING even
 * when classification fails in every way it can.
 */

let world: InMemoryRequestWorld;
let clock: FixedClock;
let requests: SupportRequestService;

const actor: Actor = {
  userId: "user_1",
  email: "c@example.com",
  roles: ["CUSTOMER"],
  status: "ACTIVE",
  emailVerified: true,
  customerProfileId: "cust_1",
};

const DESCRIPTION =
  "Our LWC on the Account page is not refreshing after an imperative Apex call. refreshApex runs but the wire never re-runs.";

beforeEach(() => {
  world = new InMemoryRequestWorld();
  clock = new FixedClock(new Date("2026-08-02T10:00:00Z"));
  requests = new SupportRequestService({
    requests: world.requests,
    taxonomy: world.taxonomy,
    pricing: world.pricing,
    attachments: world.attachments,
    payments: world.payments,
    scheduler: world.scheduler,
    clock,
    matchingWindowMinutes: 15,
    classifyQueue: "classify-request",
  });
});

describe("creating a request", () => {
  it("prices, authorizes, and lands in CLASSIFYING", async () => {
    const { request } = await requests.create(actor, {
      description: DESCRIPTION,
      pricingTierId: "tier_30",
    });

    expect(request.state).toBe("CLASSIFYING");
    expect(request.quotedPriceCents).toBe(100_000);
    // Fee split derives the payout as the remainder, so the two always reconcile.
    expect(request.quotedPlatformFeeCents + request.quotedExpertPayoutCents).toBe(100_000);
    expect(request.paymentAuthorizationRef).toBeTruthy();
    // D1: money is held before matching starts, not after an expert commits.
    expect(world.payments.authorizations).toBe(1);
    expect(request.matchDeadlineAt).toEqual(new Date("2026-08-02T10:15:00Z"));
  });

  it("enqueues classification exactly once, keyed against redelivery", async () => {
    const { request } = await requests.create(actor, {
      description: DESCRIPTION,
      pricingTierId: "tier_30",
    });
    expect(world.scheduler.jobs).toHaveLength(1);
    expect(world.scheduler.jobs[0]?.queue).toBe("classify-request");
    expect(world.scheduler.jobs[0]?.singletonKey).toBe(`classify:${request.id}`);
  });

  it("derives a title so the customer never writes one", async () => {
    const { request } = await requests.create(actor, {
      description: DESCRIPTION,
      pricingTierId: "tier_30",
    });
    expect(request.title).toBe(
      "Our LWC on the Account page is not refreshing after an imperative Apex call",
    );
  });

  it("takes the price from the tier, never from the caller", async () => {
    // A client that posts its own price changes nothing — the amount is read
    // from the tier row server-side.
    const { request } = await requests.create(actor, {
      description: DESCRIPTION,
      pricingTierId: "tier_60",
    });
    expect(request.quotedPriceCents).toBe(180_000);
  });

  it("rejects a description too short to act on", async () => {
    await expect(
      requests.create(actor, { description: "it broke", pricingTierId: "tier_30" }),
    ).rejects.toThrow(ValidationError);
    // And nothing was charged for the attempt.
    expect(world.payments.authorizations).toBe(0);
  });

  it("refuses a second request while one is in flight", async () => {
    await requests.create(actor, { description: DESCRIPTION, pricingTierId: "tier_30" });
    await expect(
      requests.create(actor, { description: DESCRIPTION, pricingTierId: "tier_30" }),
    ).rejects.toThrow(ConflictError);
    // Critically, the second attempt must not have placed a second hold.
    expect(world.payments.authorizations).toBe(1);
  });

  it("does not create a request when the card is declined", async () => {
    world.payments.declineNext = true;
    await expect(
      requests.create(actor, { description: DESCRIPTION, pricingTierId: "tier_30" }),
    ).rejects.toThrow(ValidationError);
    expect(world.requests.rows.size).toBe(0);
  });
});

describe("requirement 6 — redaction happens before anything is stored", () => {
  it("never persists a credential the customer pasted", async () => {
    const leaky = `${DESCRIPTION}\n\nSession: 00D5f000000abcdE!AQcAQH0dMHZfz.SsBcMxYo8mVXJ4Kz9pQrStUvWxYz01`;

    const { request, secretFindings } = await requests.create(actor, {
      description: leaky,
      pricingTierId: "tier_30",
    });

    expect(secretFindings).toHaveLength(1);
    expect(request.description).not.toContain("AQcAQH0dMHZ");
    // The stored row is the redacted one — there is no second copy anywhere.
    expect(world.requests.rows.get(request.id)?.description).not.toContain("AQcAQH0dMHZ");
    // And the real problem survives, which is the point of redacting rather
    // than rejecting.
    expect(request.description).toContain("refreshApex");
  });

  it("redacts a credential in the title too", async () => {
    const { request } = await requests.create(actor, {
      title: "Login fails with password=hunter2please",
      description: DESCRIPTION,
      pricingTierId: "tier_30",
    });
    expect(request.title).not.toContain("hunter2please");
  });
});

describe("assistive selections (requirement 2)", () => {
  it("accepts none at all", async () => {
    const { request } = await requests.create(actor, {
      description: DESCRIPTION,
      pricingTierId: "tier_30",
    });
    expect(request.skills).toEqual([]);
  });

  it("records them as CUSTOMER_SELECTED and never as primary", async () => {
    // Primary drives a hard competence filter in Phase 5. That judgement is not
    // the customer's to make — they are describing symptoms.
    const { request } = await requests.create(actor, {
      description: DESCRIPTION,
      pricingTierId: "tier_30",
      skillSlugs: ["apex", "lwc"],
    });
    expect(request.skills).toHaveLength(2);
    expect(request.skills.every((s) => s.source === "CUSTOMER_SELECTED")).toBe(true);
    expect(request.skills.every((s) => s.isPrimary === false)).toBe(true);
  });

  it("ignores a slug that does not exist rather than failing the request", async () => {
    const { request } = await requests.create(actor, {
      description: DESCRIPTION,
      pricingTierId: "tier_30",
      skillSlugs: ["apex", "not-a-real-skill"],
    });
    expect(request.skills.map((s) => s.slug)).toEqual(["apex"]);
  });
});

describe("cancellation", () => {
  it("cancels and releases the authorization", async () => {
    const { request } = await requests.create(actor, {
      description: DESCRIPTION,
      pricingTierId: "tier_30",
    });
    const cancelled = await requests.cancel(actor, request.id, "changed my mind");

    expect(cancelled.state).toBe("CANCELLED");
    expect(world.payments.voided).toBe(1);
  });

  it("refuses to cancel a request that already finished", async () => {
    const { request } = await requests.create(actor, {
      description: DESCRIPTION,
      pricingTierId: "tier_30",
    });
    await requests.cancel(actor, request.id);
    await expect(requests.cancel(actor, request.id)).rejects.toThrow(ConflictError);
  });

  it("frees the customer to raise another one", async () => {
    const first = await requests.create(actor, {
      description: DESCRIPTION,
      pricingTierId: "tier_30",
    });
    await requests.cancel(actor, first.request.id);
    await expect(
      requests.create(actor, { description: DESCRIPTION, pricingTierId: "tier_30" }),
    ).resolves.toBeDefined();
  });
});

describe("ownership", () => {
  const stranger: Actor = { ...actor, userId: "user_2", customerProfileId: "cust_2" };

  it("hides another customer's request", async () => {
    const { request } = await requests.create(actor, {
      description: DESCRIPTION,
      pricingTierId: "tier_30",
    });
    await expect(requests.getForCustomer(stranger, request.id)).rejects.toThrow(/permitted/i);
  });

  it("stops another customer cancelling it", async () => {
    const { request } = await requests.create(actor, {
      description: DESCRIPTION,
      pricingTierId: "tier_30",
    });
    await expect(requests.cancel(stranger, request.id)).rejects.toThrow(/permitted/i);
    expect(world.requests.rows.get(request.id)?.state).toBe("CLASSIFYING");
  });
});

// ── Classification (requirement 4) ───────────────────────────────────────────

function classificationService(classifier: ProblemClassifier, timeoutMs = 4000) {
  return new ClassificationService({
    requests: world.requests,
    taxonomy: world.taxonomy,
    classifier,
    clock,
    logger: world.logger,
    timeoutMs,
  });
}

const workingClassifier: ProblemClassifier = {
  name: "test",
  async classify() {
    return {
      primaryCategorySlug: "salesforce-development",
      skills: [
        { slug: "lwc", isPrimary: true, confidence: 0.9 },
        { slug: "apex", isPrimary: false, confidence: 0.6 },
      ],
      difficulty: "INTERMEDIATE",
      confidence: 0.88,
      model: "test-model",
      latencyMs: 12,
    };
  },
};

describe("requirement 4 — classification never blocks the request", () => {
  async function createRequest(skillSlugs?: string[]) {
    const { request } = await requests.create(actor, {
      description: DESCRIPTION,
      pricingTierId: "tier_30",
      ...(skillSlugs ? { skillSlugs } : {}),
    });
    return request;
  }

  it("attaches AI skills and reaches SEARCHING on success", async () => {
    const request = await createRequest();
    const outcome = await classificationService(workingClassifier).classify(request.id);

    expect(outcome.classified).toBe(true);
    expect(outcome.request.state).toBe("SEARCHING");
    expect(outcome.skillsAttached).toBe(2);
    expect(outcome.request.skills.filter((s) => s.source === "AI_DETECTED")).toHaveLength(2);
  });

  it("reaches SEARCHING when the classifier returns null", async () => {
    const request = await createRequest(["apex"]);
    const outcome = await classificationService({
      name: "null",
      async classify() {
        return null;
      },
    }).classify(request.id);

    expect(outcome.request.state).toBe("SEARCHING");
    expect(outcome.classified).toBe(false);
    // Fallback: the customer's own selection survives intact.
    expect(outcome.request.skills.map((s) => s.slug)).toEqual(["apex"]);
  });

  it("reaches SEARCHING when the classifier throws", async () => {
    const request = await createRequest();
    const outcome = await classificationService({
      name: "throwing",
      async classify() {
        throw new Error("provider is down");
      },
    }).classify(request.id);

    expect(outcome.request.state).toBe("SEARCHING");
    expect(outcome.failureReason).toContain("provider is down");
    // Recorded on the row, so a spike in failures is measurable rather than invisible.
    expect(world.requests.rows.get(request.id)?.aiFailureReason).toContain("provider is down");
  });

  it("reaches SEARCHING when the classifier hangs past its budget", async () => {
    vi.useFakeTimers();
    try {
      const request = await createRequest();
      const service = classificationService(
        {
          name: "slow",
          classify: () => new Promise(() => {}),
        },
        50,
      );
      const pending = service.classify(request.id);
      await vi.advanceTimersByTimeAsync(60);
      const outcome = await pending;

      expect(outcome.request.state).toBe("SEARCHING");
      expect(outcome.classified).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reaches SEARCHING with no customer selections and a dead classifier", async () => {
    // The worst case: we know nothing about the problem beyond its text. It
    // still has to get to matching.
    const request = await createRequest();
    const outcome = await classificationService({
      name: "dead",
      async classify() {
        return null;
      },
    }).classify(request.id);

    expect(outcome.request.state).toBe("SEARCHING");
    expect(outcome.request.skills).toEqual([]);
  });

  it("drops a skill slug outside the allowed set", async () => {
    const request = await createRequest();
    const outcome = await classificationService({
      name: "hallucinating",
      async classify() {
        return {
          primaryCategorySlug: "salesforce-development",
          skills: [
            { slug: "lwc", isPrimary: true, confidence: 0.9 },
            { slug: "quantum-apex", isPrimary: true, confidence: 0.99 },
          ],
          difficulty: "ADVANCED",
          confidence: 0.9,
          model: "test-model",
          latencyMs: 5,
        };
      },
    }).classify(request.id);

    expect(outcome.skillsAttached).toBe(1);
    expect(outcome.request.skills.map((s) => s.slug)).not.toContain("quantum-apex");
  });

  it("is idempotent when the job is redelivered", async () => {
    const request = await createRequest();
    const service = classificationService(workingClassifier);

    const first = await service.classify(request.id);
    const second = await service.classify(request.id);

    expect(first.request.state).toBe("SEARCHING");
    expect(second.request.state).toBe("SEARCHING");
    // No duplicate skills, no second transition.
    expect(second.request.skills.filter((s) => s.source === "AI_DETECTED")).toHaveLength(2);
    expect(world.requests.transitions.filter((t) => t.toState === "SEARCHING")).toHaveLength(1);
  });
});

describe("deriveTitle", () => {
  it("takes the first sentence", () => {
    expect(deriveTitle("Flow is broken. It throws on save.")).toBe("Flow is broken");
  });

  it("takes the first line when there is no sentence break", () => {
    expect(deriveTitle("Batch job times out\nafter 4000 records")).toBe("Batch job times out");
  });

  it("truncates something very long", () => {
    const title = deriveTitle("x".repeat(400));
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.endsWith("…")).toBe(true);
  });

  it("falls back rather than returning an empty string", () => {
    expect(deriveTitle("   ")).toBe("Salesforce support request");
  });
});
