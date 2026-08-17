import type { CurrencyCode } from "@sfx/contracts";
import type { PrismaClient, PrismaTransactionClient } from "@sfx/db";
import type { PaymentRecord, PaymentRepository, PaymentStatus } from "@sfx/domain";

type Db = PrismaClient | PrismaTransactionClient;

type PaymentRow = {
  id: string;
  supportRequestId: string;
  customerId: string;
  provider: string;
  providerRef: string;
  amountCents: number;
  currency: string;
  status: PaymentStatus;
  authorizedAt: Date | null;
  capturedAt: Date | null;
  failureCode: string | null;
  failureMessage: string | null;
};

function toPayment(row: PaymentRow): PaymentRecord {
  return { ...row, currency: row.currency as CurrencyCode };
}

/**
 * One payment per request, enforced by the schema rather than by this class.
 *
 * `Payment.supportRequestId` is unique, which is what makes `upsertForRequest`
 * safe under a double-clicked Pay button: two concurrent calls cannot produce
 * two rows, because the second one updates the first. The service's "have we
 * already charged?" check reads before it writes and therefore cannot be the
 * guarantee — only the constraint can.
 */
export class PrismaPaymentRepository implements PaymentRepository {
  constructor(private readonly db: Db) {}

  async upsertForRequest(input: {
    supportRequestId: string;
    customerId: string;
    provider: string;
    providerRef: string;
    amountCents: number;
    currency: CurrencyCode;
    status: PaymentStatus;
    authorizedAt: Date | null;
    failureCode?: string | null;
    failureMessage?: string | null;
  }): Promise<PaymentRecord> {
    const row = await this.db.payment.upsert({
      where: { supportRequestId: input.supportRequestId },
      create: {
        supportRequestId: input.supportRequestId,
        customerId: input.customerId,
        provider: input.provider,
        providerRef: input.providerRef,
        amountCents: input.amountCents,
        currency: input.currency,
        status: input.status,
        authorizedAt: input.authorizedAt,
        failureCode: input.failureCode ?? null,
        failureMessage: input.failureMessage ?? null,
      },
      // Deliberately does NOT touch `capturedAt`. Capture happens at the end of
      // a session, and a retried authorization must never reopen money that has
      // already been taken.
      update: {
        provider: input.provider,
        providerRef: input.providerRef,
        amountCents: input.amountCents,
        currency: input.currency,
        status: input.status,
        authorizedAt: input.authorizedAt,
        failureCode: input.failureCode ?? null,
        failureMessage: input.failureMessage ?? null,
      },
    });
    return toPayment(row as PaymentRow);
  }

  async findForRequest(supportRequestId: string): Promise<PaymentRecord | null> {
    const row = await this.db.payment.findUnique({ where: { supportRequestId } });
    return row ? toPayment(row as PaymentRow) : null;
  }

  async markCaptured(params: {
    supportRequestId: string;
    capturedAt: Date;
  }): Promise<PaymentRecord | null> {
    // AUTHORIZED is the guard, so a replayed capture — a duplicate webhook, a
    // retried job — changes nothing and returns null rather than moving money
    // twice or resurrecting a refunded payment.
    const result = await this.db.payment.updateMany({
      where: { supportRequestId: params.supportRequestId, status: "AUTHORIZED" },
      data: { status: "CAPTURED", capturedAt: params.capturedAt },
    });
    if (result.count === 0) return null;
    return this.findForRequest(params.supportRequestId);
  }
}
