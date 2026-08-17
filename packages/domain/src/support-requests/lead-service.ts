import type { SupportType } from "@sfx/contracts";
import type { Clock } from "../ports/clock.js";
import type { CrmGateway } from "../ports/crm.js";
import type { Logger } from "../ports/logger.js";
import type {
  JobScheduler,
  SupportLeadRecord,
  SupportLeadRepository,
} from "../ports/request-repositories.js";
import { scanForSecrets } from "../security/secret-scanner.js";
import { NotFoundError } from "../shared/errors.js";

/**
 * Someone asks for help, and a human gets told.
 *
 * The whole customer-facing product in this phase. No account, no matching, no
 * payment, no session — the platform captures the enquiry reliably and puts it
 * in front of the sales team, who route it to an approved expert by hand.
 *
 * ## Anonymous on purpose
 *
 * There is no `authorize` call here, and that is the design rather than an
 * oversight: the form is public, and requiring an account to ask a question is
 * friction on the single action the site exists to collect. The protections that
 * still apply to a stranger remain — redaction here, rate limiting at the route.
 *
 * ## The CRM is downstream of the record, never in front of it
 *
 * `submit` writes the lead and returns. Pushing to Salesforce is a scheduled
 * job, so an outage, a rate limit or an expired token costs a retry rather than
 * an enquiry. Doing it inline would make the customer's "thank you" screen
 * depend on a third party being awake.
 */

export interface LeadServiceDeps {
  readonly leads: SupportLeadRepository;
  readonly scheduler: JobScheduler;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly crmSyncQueue: string;
  /** Absent when no CRM is configured; sync then does nothing rather than fail. */
  readonly crm?: CrmGateway;
  /** How many failed pushes before a lead stops being retried automatically. */
  readonly maxCrmAttempts?: number;
}

export interface SubmitLeadInput {
  readonly supportType: SupportType;
  readonly preferredCallAt: Date | null;
  readonly preferredTimezone: string | null;
  readonly certification: string | null;
  readonly certificationExamOn: Date | null;
  readonly certificationHelp: readonly string[];
  readonly title: string | null;
  readonly engagementCount: number | null;
  readonly engagementUnit: "WEEK" | "MONTH" | "YEAR" | null;
  readonly budgetBasis: "HOURLY" | "MONTHLY" | null;
  readonly budgetAmountCents: number | null;
  readonly budgetCurrency: string | null;
  readonly budgetNegotiable: boolean;

  readonly name: string;
  readonly email: string;
  readonly phone: string;
  readonly summary: string;
  readonly durationMinutes: number | null;
  readonly quotedPriceCents: number | null;
  readonly currency: string | null;
  /** Set only when a signed-in customer submits; anonymous is the normal case. */
  readonly customerId?: string | null;
}

const DEFAULT_MAX_ATTEMPTS = 8;

export class SupportLeadService {
  constructor(private readonly deps: LeadServiceDeps) {}

  async submit(input: SubmitLeadInput): Promise<SupportLeadRecord> {
    // Requirement 31, and it matters more here than anywhere else in the
    // product: an unauthenticated box on a public page is the most likely place
    // for someone to paste a session id, a password or a connection string.
    const summary = scanForSecrets(input.summary);
    const name = scanForSecrets(input.name);

    const lead = await this.deps.leads.create({
      customerId: input.customerId ?? null,
      supportType: input.supportType,
      preferredCallAt: input.preferredCallAt,
      preferredTimezone: input.preferredTimezone,
      /*
        Not redacted, unlike the title and the description. This is one of
        forty-eight values from a fixed list, so there is nowhere in it for a
        pasted secret to hide — and running the scanner over it would only
        create the possibility of mangling a legitimate credential name.
      */
      certification: input.certification,
      certificationExamOn: input.certificationExamOn,
      certificationHelp: input.certificationHelp,
      // Redacted too. A title is a free-text field on a public form, so it is
      // exactly as capable of carrying a pasted secret as the description.
      title: input.title === null ? null : scanForSecrets(input.title).redacted,
      engagementCount: input.engagementCount,
      engagementUnit: input.engagementUnit,
      budgetBasis: input.budgetBasis,
      budgetAmountCents: input.budgetAmountCents,
      budgetCurrency: input.budgetCurrency,
      budgetNegotiable: input.budgetNegotiable,
      name: name.redacted,
      email: input.email.trim().toLowerCase(),
      phone: input.phone.trim(),
      summary: summary.redacted,
      durationMinutes: input.durationMinutes,
      quotedPriceCents: input.quotedPriceCents,
      currency: input.currency,
    });

    // Enqueued after the write and keyed on the lead, so a duplicate delivery
    // cannot become a duplicate record in the CRM.
    await this.deps.scheduler.enqueue({
      queue: this.deps.crmSyncQueue,
      payload: { leadId: lead.id },
      singletonKey: `crm-sync:${lead.id}`,
    });

    this.deps.logger.info("lead captured", {
      leadId: lead.id,
      supportType: input.supportType,
      durationMinutes: input.durationMinutes,
      redactedFindings: summary.findings.length,
    });

    return lead;
  }

  /**
   * Push one lead to the CRM.
   *
   * Idempotent in both directions: a lead already synced returns immediately,
   * and the key handed to the gateway lets the CRM reject a duplicate we failed
   * to record the first time.
   */
  async syncToCrm(leadId: string): Promise<{ status: string }> {
    const lead = await this.deps.leads.findById(leadId);
    if (!lead) throw new NotFoundError("SupportLead", leadId);
    if (lead.crmSyncedAt) return { status: "already_synced" };
    if (!this.deps.crm) return { status: "no_crm_configured" };

    const result = await this.deps.crm.pushLead({
      idempotencyKey: lead.id,
      supportType: lead.supportType,
      preferredCallAt: lead.preferredCallAt,
      preferredTimezone: lead.preferredTimezone,
      certification: lead.certification,
      certificationExamOn: lead.certificationExamOn,
      certificationHelp: lead.certificationHelp,
      title: lead.title,
      engagementCount: lead.engagementCount,
      engagementUnit: lead.engagementUnit,
      budgetBasis: lead.budgetBasis,
      budgetAmountCents: lead.budgetAmountCents,
      budgetNegotiable: lead.budgetNegotiable,
      name: lead.name,
      email: lead.email,
      phone: lead.phone,
      summary: lead.summary,
      durationMinutes: lead.durationMinutes,
      quotedPriceCents: lead.quotedPriceCents,
      currency: lead.currency,
      submittedAt: lead.createdAt,
    });

    if (result.status === "created" || result.status === "duplicate") {
      await this.deps.leads.recordCrmOutcome({
        id: lead.id,
        crmRef: result.recordId,
        syncedAt: this.deps.clock.now(),
        error: null,
      });
      this.deps.logger.info("lead reached the CRM", {
        leadId: lead.id,
        crmRef: result.recordId,
        duplicate: result.status === "duplicate",
      });
      return { status: result.status };
    }

    await this.deps.leads.recordCrmOutcome({
      id: lead.id,
      crmRef: null,
      syncedAt: null,
      error: result.reason,
    });

    if (result.status === "rejected") {
      // Deliberately not thrown. A rejection is permanent, so failing the job
      // would retry something that cannot succeed and bury the lead in a queue
      // rather than surfacing it. The row keeps the reason; the sweep skips it.
      this.deps.logger.error("the CRM refused a lead — needs a human", {
        leadId: lead.id,
        reason: result.reason,
      });
      return { status: "rejected" };
    }

    // Retryable: throwing hands the backoff to the job runner, which already
    // knows how to do it.
    throw new Error(`CRM push failed for ${lead.id}: ${result.reason}`);
  }

  /** Backstop for a lost job. Same shape as the other reconcilers. */
  async retryUnsynced(limit = 25): Promise<{ attempted: number }> {
    const stuck = await this.deps.leads.listAwaitingCrm({
      limit,
      maxAttempts: this.deps.maxCrmAttempts ?? DEFAULT_MAX_ATTEMPTS,
    });
    for (const lead of stuck) {
      await this.deps.scheduler.enqueue({
        queue: this.deps.crmSyncQueue,
        payload: { leadId: lead.id },
        singletonKey: `crm-sync:${lead.id}`,
      });
    }
    return { attempted: stuck.length };
  }
}
