/**
 * Where an enquiry goes once we have it.
 *
 * A port rather than a Salesforce client, for the usual reason and one specific
 * one: the CRM is the *sales team's* tool, not the product's. It will be
 * reconfigured, migrated and re-pointed by people who are not looking at this
 * codebase, and a direct dependency would make each of those a deployment.
 *
 * Implementations must be safe to retry. Every push carries an `idempotencyKey`
 * derived from the lead, because the durable-job retry that protects against a
 * CRM outage is also the thing most likely to deliver twice.
 */

export interface CrmLead {
  readonly idempotencyKey: string;
  /** One-off or ongoing. The first thing the sales team wants to know. */
  readonly supportType: "INSTANT" | "SCHEDULED" | "LONG_TERM" | "CERTIFICATION";
  readonly name: string;
  readonly email: string;
  readonly phone: string;
  /** Already redacted. A CRM is not a safe place for a credential either. */
  readonly summary: string;
  readonly durationMinutes: number | null;
  /* ── Certification only. ────────────────────────────────────────────────── */
  /** Which credential they are working towards. */
  readonly certification: string | null;
  /** The day they sit it, when booked. Date-only; no zone applies. */
  readonly certificationExamOn: Date | null;
  /** What kind of help they asked for. Empty on every other path. */
  readonly certificationHelp: readonly string[];
  /* ── Long-term only; null on an instant enquiry. ────────────────────────── */
  readonly preferredCallAt: Date | null;
  readonly preferredTimezone: string | null;
  readonly title: string | null;
  readonly engagementCount: number | null;
  readonly engagementUnit: "WEEK" | "MONTH" | "YEAR" | null;
  readonly budgetBasis: "HOURLY" | "MONTHLY" | null;
  readonly budgetAmountCents: number | null;
  readonly budgetNegotiable: boolean;
  readonly quotedPriceCents: number | null;
  readonly currency: string | null;
  readonly submittedAt: Date;
}

export type CrmPushResult =
  | { readonly status: "created"; readonly recordId: string }
  /** Already present — a retry that arrived after a success we did not record. */
  | { readonly status: "duplicate"; readonly recordId: string }
  /**
   * The push failed in a way that is worth trying again: a timeout, a 5xx, a
   * rate limit, an expired token. The caller keeps the lead and retries.
   */
  | { readonly status: "retryable"; readonly reason: string }
  /**
   * The push failed in a way that will never succeed: a validation rule, a
   * required field the CRM has and we do not, a permission problem. Retrying
   * wastes attempts and hides the lead behind a queue, so the caller stops and
   * surfaces it instead.
   */
  | { readonly status: "rejected"; readonly reason: string };

export interface CrmGateway {
  readonly name: string;
  pushLead(lead: CrmLead): Promise<CrmPushResult>;
}
