import { describe, expect, it } from "vitest";
import { MockPaymentGateway } from "./mock-payment-gateway.js";

/**
 * These test the D1 flow, not the mock.
 *
 * D1 says: authorize at submission, capture at completion, void when no expert
 * is found. Phases 1–6 run entirely on this gateway, so if the lifecycle it
 * enforces is wrong, every phase built on top inherits the mistake — and we
 * would only discover it when a real provider is wired in Phase 7a.
 */

const base = {
  idempotencyKey: "req_1",
  amountMinor: 100_000,
  currency: "INR" as const,
  customerRef: null,
  description: "30-minute session",
  metadata: {},
};

describe("D1: authorize before matching", () => {
  it("holds funds without taking them", async () => {
    const gateway = new MockPaymentGateway();
    const auth = await gateway.authorize(base);
    expect(auth.status).toBe("authorized");
    expect(auth.amountMinor).toBe(100_000);
  });

  it("returns the same authorization for a replayed idempotency key", async () => {
    // A retried submission must not place two holds on the customer's card.
    const gateway = new MockPaymentGateway();
    const first = await gateway.authorize(base);
    const second = await gateway.authorize(base);
    expect(second.providerRef).toBe(first.providerRef);
  });

  it("surfaces a declined card as data, not an exception", async () => {
    const gateway = new MockPaymentGateway({ failAuthorizations: true });
    const auth = await gateway.authorize(base);
    expect(auth.status).toBe("failed");
    expect(auth.failureCode).toBe("card_declined");
  });
});

describe("capture on session completion", () => {
  it("captures a held authorization", async () => {
    const gateway = new MockPaymentGateway();
    const auth = await gateway.authorize(base);
    const capture = await gateway.capture(auth.providerRef, 100_000, "cap_1");
    expect(capture.capturedMinor).toBe(100_000);
  });

  it("refuses a second capture with a different key", async () => {
    // The double-charge bug, caught at the port.
    const gateway = new MockPaymentGateway();
    const auth = await gateway.authorize(base);
    await gateway.capture(auth.providerRef, 100_000, "cap_1");
    await expect(gateway.capture(auth.providerRef, 100_000, "cap_2")).rejects.toThrow(
      /already captured/,
    );
  });

  it("treats a replayed capture as a no-op", async () => {
    // Webhooks are delivered at least once (§37.14).
    const gateway = new MockPaymentGateway();
    const auth = await gateway.authorize(base);
    const first = await gateway.capture(auth.providerRef, 100_000, "cap_1");
    const replay = await gateway.capture(auth.providerRef, 100_000, "cap_1");
    expect(replay.capturedMinor).toBe(first.capturedMinor);
  });

  it("refuses to capture more than was authorized", async () => {
    const gateway = new MockPaymentGateway();
    const auth = await gateway.authorize(base);
    await expect(gateway.capture(auth.providerRef, 200_000, "cap_1")).rejects.toThrow(/exceeds/);
  });
});

describe("void when no expert is found", () => {
  it("releases the hold and blocks a later capture", async () => {
    const gateway = new MockPaymentGateway();
    const auth = await gateway.authorize(base);
    await gateway.void(auth.providerRef, "void_1");
    await expect(gateway.capture(auth.providerRef, 100_000, "cap_1")).rejects.toThrow(/voided/);
  });

  it("refuses to void money already taken", async () => {
    const gateway = new MockPaymentGateway();
    const auth = await gateway.authorize(base);
    await gateway.capture(auth.providerRef, 100_000, "cap_1");
    await expect(gateway.void(auth.providerRef, "void_1")).rejects.toThrow(/refund instead/);
  });
});

describe("refunds", () => {
  it("refuses to over-refund across multiple partials", async () => {
    const gateway = new MockPaymentGateway();
    const auth = await gateway.authorize(base);
    await gateway.capture(auth.providerRef, 100_000, "cap_1");

    await gateway.refund({
      idempotencyKey: "ref_1",
      captureRef: auth.providerRef,
      amountMinor: 60_000,
      reason: "partial",
    });
    await expect(
      gateway.refund({
        idempotencyKey: "ref_2",
        captureRef: auth.providerRef,
        amountMinor: 60_000,
        reason: "too much",
      }),
    ).rejects.toThrow(/exceeds refundable/);
  });
});

describe("webhook verification", () => {
  it("rejects an unsigned payload", () => {
    const gateway = new MockPaymentGateway();
    expect(gateway.parseWebhook(JSON.stringify({ id: "e1", type: "captured" }), {})).toBeNull();
  });

  it("rejects malformed JSON rather than throwing", () => {
    const gateway = new MockPaymentGateway();
    expect(gateway.parseWebhook("not json", { "x-mock-signature": "valid" })).toBeNull();
  });

  it("normalises a signed payload", () => {
    const gateway = new MockPaymentGateway();
    const event = gateway.parseWebhook(JSON.stringify({ id: "e1", type: "captured" }), {
      "x-mock-signature": "valid",
    });
    expect(event?.externalEventId).toBe("e1");
  });
});
