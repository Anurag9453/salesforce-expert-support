import type { CurrencyCode } from "@sfx/contracts";

export type PaymentStatus =
  | "REQUIRES_METHOD"
  | "AUTHORIZED"
  | "CAPTURED"
  | "FAILED"
  | "CANCELLED"
  | "REFUNDED"
  | "PARTIALLY_REFUNDED";

export interface PaymentRecord {
  readonly id: string;
  readonly supportRequestId: string;
  readonly customerId: string;
  readonly provider: string;
  readonly providerRef: string;
  readonly amountCents: number;
  readonly currency: CurrencyCode;
  readonly status: PaymentStatus;
  readonly authorizedAt: Date | null;
  readonly capturedAt: Date | null;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
}

export interface PaymentRepository {
  /**
   * Record a payment against a request, or return the one already there.
   *
   * Idempotent on `supportRequestId`, which is unique. A customer who
   * double-clicks Pay, or a retried request, must not produce two payments for
   * one session — and the check has to be the database's rather than the
   * service's, because two clicks can be in flight at once.
   */
  upsertForRequest(input: {
    readonly supportRequestId: string;
    readonly customerId: string;
    readonly provider: string;
    readonly providerRef: string;
    readonly amountCents: number;
    readonly currency: CurrencyCode;
    readonly status: PaymentStatus;
    readonly authorizedAt: Date | null;
    readonly failureCode?: string | null;
    readonly failureMessage?: string | null;
  }): Promise<PaymentRecord>;

  findForRequest(supportRequestId: string): Promise<PaymentRecord | null>;

  /** Guarded on the payment still being AUTHORIZED, so a replay is a no-op. */
  markCaptured(params: {
    readonly supportRequestId: string;
    readonly capturedAt: Date;
  }): Promise<PaymentRecord | null>;
}
