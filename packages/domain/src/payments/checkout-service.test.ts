import { beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../authorization/index.js";
import type { Logger } from "../ports/logger.js";
import type { Authorization, PaymentGateway } from "../ports/payment.js";
import type { PaymentRecord, PaymentRepository } from "../ports/payment-repository.js";
import type {
  StateTransitionInput,
  SupportRequestRecord,
  SupportRequestRepository,
} from "../ports/request-repositories.js";
import { CheckoutService } from "./checkout-service.js";

/**
 * The money rules for the shortlist flow.
 *
 * Every test here is about a way the platform could take money it should not,
 * or open a room it should not. Those are the two failures that cost trust
 * rather than time.
 */

const NOW = new Date("2026-08-16T12:00:00Z");

const customer: Actor = {
  userId: "user_customer",
  email: "c@local.test",
  roles: ["CUSTOMER"],
  status: "ACTIVE",
  emailVerified: true,
  customerProfileId: "cust_1",
} as unknown as Actor;

const stranger: Actor = { ...customer, userId: "user_other", customerProfileId: "cust_2" };

function requestRecord(overrides: Partial<SupportRequestRecord> = {}): SupportRequestRecord {
  return {
    id: "req_1",
    customerId: "cust_1",
    state: "PAYMENT_PENDING",
    version: 4,
    quotedPriceCents: 3635,
    currency: "USD",
    ...overrides,
  } as unknown as SupportRequestRecord;
}

class FakePayments implements PaymentRepository {
  rows: PaymentRecord[] = [];

  async upsertForRequest(input: Parameters<PaymentRepository["upsertForRequest"]>[0]) {
    // Mirrors the unique index on supportRequestId: one payment per request.
    const existing = this.rows.find((r) => r.supportRequestId === input.supportRequestId);
    const row = {
      id: existing?.id ?? `pay_${String(this.rows.length + 1)}`,
      capturedAt: null,
      failureCode: null,
      failureMessage: null,
      ...input,
    } as PaymentRecord;
    this.rows = [...this.rows.filter((r) => r.supportRequestId !== input.supportRequestId), row];
    return row;
  }
  async findForRequest(supportRequestId: string) {
    return this.rows.find((r) => r.supportRequestId === supportRequestId) ?? null;
  }
  async markCaptured() {
    return null;
  }
}

class FakeGateway implements PaymentGateway {
  readonly name = "fake";
  calls: string[] = [];
  next: Authorization["status"] = "authorized";

  async authorize(request: { idempotencyKey: string }): Promise<Authorization> {
    this.calls.push(request.idempotencyKey);
    return {
      providerRef: `ref_${String(this.calls.length)}`,
      provider: "fake",
      status: this.next,
      amountMinor: 3635,
      currency: "USD",
      ...(this.next === "failed"
        ? { failureCode: "card_declined", failureMessage: "Your card was declined." }
        : {}),
    } as Authorization;
  }
  // Capture belongs to the session's close-out, not to checkout. Throwing rather
  // than returning a plausible value means a test that reaches it fails loudly
  // instead of quietly asserting against a fiction.
  capture(): Promise<never> {
    throw new Error("capture is not part of checkout");
  }
  void(): Promise<never> {
    throw new Error("void is not part of checkout");
  }
  refund(): Promise<never> {
    throw new Error("refund is not part of checkout");
  }
  parseWebhook(): null {
    return null;
  }
}

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

function build(request: SupportRequestRecord) {
  const payments = new FakePayments();
  const gateway = new FakeGateway();
  const transitions: Array<{ from: string; to: string }> = [];
  let current = request;

  const service = new CheckoutService({
    requests: {
      findById: async (id: string) => (id === current.id ? current : null),
      applyTransition: async (input: StateTransitionInput) => {
        // Optimistic concurrency, modelled: a stale version loses, exactly as
        // the WHERE guard in the adapter does.
        if (input.expectedVersion !== current.version) return null;
        transitions.push({ from: String(input.fromState), to: input.toState });
        current = { ...current, state: input.toState, version: current.version + 1 };
        return current;
      },
    } as unknown as SupportRequestRepository,
    payments,
    gateway,
    auditLog: { record: async () => undefined, listForEntity: async () => [] },
    clock: { now: () => NOW },
    logger: silentLogger,
  });

  return { service, payments, gateway, transitions, state: () => current.state };
}

describe("paying for a confirmed session", () => {
  let world: ReturnType<typeof build>;
  beforeEach(() => {
    world = build(requestRecord());
  });

  it("opens the session once the payment is authorized", async () => {
    const payment = await world.service.pay(customer, "req_1");

    expect(payment.status).toBe("AUTHORIZED");
    expect(world.state()).toBe("READY");
    expect(world.transitions).toEqual([{ from: "PAYMENT_PENDING", to: "READY" }]);
  });

  it("charges the request's own quoted price, never a caller's number", async () => {
    const payment = await world.service.pay(customer, "req_1");
    expect(payment.amountCents).toBe(3635);
  });

  it("uses an idempotency key tied to the request, so a retry cannot double-charge", async () => {
    await world.service.pay(customer, "req_1");
    expect(world.gateway.calls).toEqual(["checkout:req_1"]);
  });
});

describe("what it refuses", () => {
  it("will not let another customer pay for someone else's request", async () => {
    const world = build(requestRecord());
    await expect(world.service.pay(stranger, "req_1")).rejects.toThrow(/support_request:read_own/);
    expect(world.state()).toBe("PAYMENT_PENDING");
  });

  it("will not take money for a request that is not waiting for it", async () => {
    const world = build(requestRecord({ state: "SEARCHING" }));
    await expect(world.service.pay(customer, "req_1")).rejects.toThrow(/not waiting for payment/);
    expect(world.gateway.calls).toHaveLength(0);
  });

  it("returns the existing payment instead of charging twice", async () => {
    const world = build(requestRecord());
    const first = await world.service.pay(customer, "req_1");
    // The request is now READY. A double-submitted form lands here.
    const second = await world.service.pay(customer, "req_1");

    expect(second.id).toBe(first.id);
    expect(world.gateway.calls).toHaveLength(1);
    expect(world.payments.rows).toHaveLength(1);
  });
});

describe("when the card fails", () => {
  it("keeps the expert, and lets the customer try again", async () => {
    const world = build(requestRecord());
    world.gateway.next = "failed";

    await expect(world.service.pay(customer, "req_1")).rejects.toThrow(/declined/);

    // The whole point: a declined card must not cost the customer the expert
    // who just committed two minutes to confirming for them.
    expect(world.state()).toBe("PAYMENT_PENDING");
    expect(world.payments.rows[0]?.status).toBe("FAILED");
  });

  it("does not open the room when the payment needs another step", async () => {
    const world = build(requestRecord());
    world.gateway.next = "requires_action";

    const payment = await world.service.pay(customer, "req_1");

    expect(payment.status).toBe("REQUIRES_METHOD");
    expect(world.state()).toBe("PAYMENT_PENDING");
    expect(world.transitions).toHaveLength(0);
  });
});

describe("losing a race", () => {
  it("refuses to open a room on a request that moved underneath it", async () => {
    const world = build(requestRecord({ version: 4 }));
    // Someone cancelled between the read and the write: the optimistic guard
    // fails, and this must be a conflict rather than a silent success.
    const service = new CheckoutService({
      requests: {
        findById: async () => requestRecord({ version: 4 }),
        applyTransition: async () => null,
      } as unknown as SupportRequestRepository,
      payments: new FakePayments(),
      gateway: new FakeGateway(),
      auditLog: { record: async () => undefined, listForEntity: async () => [] },
      clock: { now: () => NOW },
      logger: silentLogger,
    });

    await expect(service.pay(customer, "req_1")).rejects.toThrow(/changed while the payment/);
    expect(world.state()).toBe("PAYMENT_PENDING");
  });
});
