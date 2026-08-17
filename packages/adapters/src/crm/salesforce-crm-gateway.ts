import type { CrmGateway, CrmLead, CrmPushResult, Logger } from "@sfx/domain";

/**
 * Pushes an enquiry into Salesforce as a Lead with a child Issue record.
 *
 * Two objects, split along what each is for:
 *
 *   - **Lead** carries the person and the commercial facts — name, email, phone,
 *     requested duration, quoted amount, and the standard `Status` that drives
 *     the sales process. Standard Lead rather than a custom object, because
 *     assignment rules, queues and email alerts already understand it.
 *   - **Issue_Information__c** carries what they actually described. It hangs off
 *     the Lead by lookup — not master-detail, because Salesforce does not permit
 *     Lead to be a master.
 *
 * ## Idempotency is now structural
 *
 * Both objects have an External Id holding our own lead id, so both writes are
 * PATCH upserts. A retried job updates the same two records instead of creating
 * a second pair. This replaced an earlier version that searched `Description`
 * for a marker string before creating — that worked, but it was a text search
 * standing in for a key, and it would have quietly failed the moment anyone
 * edited the description in Salesforce.
 *
 * ## What is not handled here
 *
 * Lead conversion does not carry the child across. If the sales team converts a
 * Lead, its Issue record stays behind pointing at a converted Lead. Moving it
 * onto the Opportunity is a Flow on the Salesforce side, not something this can
 * do from outside.
 */

const API_VERSION = "v62.0";
/**
 * The Lead is keyed on the *person*, the Issue on the *submission*.
 *
 * That asymmetry is the whole deduplication design. Someone who comes back a
 * month later with a second problem is the same lead and a new issue — keying
 * both on the submission id would have produced a duplicate Lead every time,
 * and keying both on the email would have overwritten their first problem with
 * their second.
 */
const LEAD_EXTERNAL_ID = "Customer_Key__c";
const ISSUE_OBJECT = "Issue_Information__c";
const ISSUE_EXTERNAL_ID = "Platform_Lead_Id__c";

/**
 * The customer key: their email, lowercased and trimmed.
 *
 * Email rather than name or phone because it is the one field people get right
 * — they want the reply. Stored in the clear rather than hashed so that a human
 * looking at a merged Lead can see exactly what matched it.
 *
 * Deliberately *not* clever about provider-specific aliasing (gmail dots,
 * plus-addressing). Those rules differ per provider and guessing wrong merges
 * two real people into one record, which is far worse than two records for one
 * person.
 */
export function customerKey(email: string): string {
  return email.trim().toLowerCase();
}

export interface SalesforceCrmOptions {
  readonly instanceUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly logger: Logger;
  /** Default company for enquiries that did not name one. */
  readonly fallbackCompany?: string;
  /** Where a new enquiry starts in the sales process. */
  readonly initialLeadStatus?: string;
}

interface CachedToken {
  readonly accessToken: string;
  readonly apiBase: string;
}

export class SalesforceCrmGateway implements CrmGateway {
  readonly name = "salesforce";
  private token: CachedToken | null = null;

  constructor(private readonly options: SalesforceCrmOptions) {}

  async pushLead(lead: CrmLead): Promise<CrmPushResult> {
    try {
      const leadResult = await this.upsertLead(lead);
      if (leadResult.status !== "created" && leadResult.status !== "duplicate") {
        return leadResult;
      }

      // The issue is written second and its failure is *not* fatal to the push.
      // The enquiry has already reached a human by this point — the Lead exists,
      // assignment rules have run, the alert has fired. Failing the whole job
      // over the child would re-send all of that on the retry.
      const issue = await this.upsertIssue(lead, leadResult.recordId);
      if (issue.status === "rejected" || issue.status === "retryable") {
        this.options.logger.warn("lead reached Salesforce but its issue record did not", {
          leadId: lead.idempotencyKey,
          crmLeadId: leadResult.recordId,
          reason: issue.status === "rejected" ? issue.reason : issue.reason,
        });
      }

      return leadResult;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.options.logger.warn("salesforce push failed", { reason });
      return { status: "retryable", reason };
    }
  }

  // ── Auth ───────────────────────────────────────────────────────────────────

  /**
   * Client Credentials flow, cached until it stops working.
   *
   * No expiry arithmetic: session lifetime is an org setting we do not control,
   * so guessing it means either refreshing constantly or using a token that died
   * early. Reacting to a 401 is simpler and correct.
   */
  private async accessToken(force = false): Promise<CachedToken> {
    if (this.token && !force) return this.token;

    const base = this.options.instanceUrl.replace(/\/$/, "");
    const response = await fetch(`${base}/services/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
      }),
    });

    const body = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      instance_url?: string;
      error?: string;
      error_description?: string;
    };

    if (!response.ok || !body.access_token) {
      throw new Error(
        `token exchange failed (${String(response.status)}): ${body.error ?? "unknown"} ${body.error_description ?? ""}`.trim(),
      );
    }

    this.token = {
      accessToken: body.access_token,
      apiBase: (body.instance_url ?? base).replace(/\/$/, ""),
    };
    return this.token;
  }

  /** One retry on 401, because an expired session is the expected failure. */
  private async call(path: string, init: RequestInit): Promise<Response> {
    const token = await this.accessToken();
    const send = (t: CachedToken) =>
      fetch(`${t.apiBase}${path}`, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${t.accessToken}` },
      });

    const first = await send(token);
    if (first.status !== 401) return first;
    return send(await this.accessToken(true));
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  /**
   * Match on the person, creating the Lead only if they are new.
   *
   * A returning customer updates their own Lead — name, phone and the latest
   * quote — rather than spawning a second one for the sales team to merge by
   * hand. Their earlier problems stay intact on their own Issue records.
   */
  private async upsertLead(lead: CrmLead): Promise<CrmPushResult> {
    const { firstName, lastName } = splitName(lead.name);

    const response = await this.call(
      `/services/data/${API_VERSION}/sobjects/Lead/${LEAD_EXTERNAL_ID}/${encodeURIComponent(customerKey(lead.email))}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          // Runs the org's lead assignment rules, which is how this reaches a
          // person. Without it the Lead lands owned by the integration user and
          // nobody is told.
          "Sforce-Auto-Assign": "TRUE",
        },
        body: JSON.stringify({
          FirstName: firstName,
          LastName: lastName,
          Company: this.options.fallbackCompany ?? "Not provided (web enquiry)",
          Email: lead.email,
          Phone: lead.phone,
          LeadSource: "Web",
          Status: this.options.initialLeadStatus ?? "Open - Not Contacted",
          Duration_Minutes__c: lead.durationMinutes,
          Quoted_Amount__c: lead.quotedPriceCents === null ? null : lead.quotedPriceCents / 100,
          Quoted_Currency__c: lead.currency,
          // The most recent enquiry from this person. Each individual submission
          // keeps its own id on its Issue record, so nothing is lost by this
          // being overwritten.
          Platform_Lead_Id__c: lead.idempotencyKey,
        }),
      },
    );

    return this.interpret(response, lead.idempotencyKey, "Lead");
  }

  private async upsertIssue(lead: CrmLead, crmLeadId: string): Promise<CrmPushResult> {
    const response = await this.call(
      `/services/data/${API_VERSION}/sobjects/${ISSUE_OBJECT}/${ISSUE_EXTERNAL_ID}/${encodeURIComponent(lead.idempotencyKey)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          Lead__c: crmLeadId,
          Description__c: lead.summary,
          Submitted_At__c: lead.submittedAt.toISOString(),
          // Duplicated from the Lead on purpose. The Lead holds the *latest*
          // quote, which a returning customer overwrites; each issue keeps what
          // was asked for on that occasion, so the history survives.
          Duration_Minutes__c: lead.durationMinutes,
          Quoted_Amount__c: lead.quotedPriceCents === null ? null : lead.quotedPriceCents / 100,
          Quoted_Currency__c: lead.currency,
        }),
      },
    );

    return this.interpret(response, lead.idempotencyKey, ISSUE_OBJECT);
  }

  /**
   * Turn an HTTP response into something the caller can act on.
   *
   * The distinction that matters is retryable versus rejected. A 4xx from the
   * org — a validation rule, a required custom field, a picklist value it does
   * not have — will fail identically forever, and retrying it buries the
   * enquiry in a queue instead of surfacing the reason.
   */
  private async interpret(response: Response, key: string, object: string): Promise<CrmPushResult> {
    if (response.ok) {
      // 201 on insert, 200 on update, 204 on update with no body.
      const body = (await response.json().catch(() => ({}))) as { id?: string; created?: boolean };
      return {
        status: body.created === false ? "duplicate" : "created",
        recordId: body.id ?? key,
      };
    }

    const text = await response.text();
    if (response.status >= 400 && response.status < 500 && response.status !== 401) {
      return {
        status: "rejected",
        reason: `${object} ${String(response.status)}: ${text.slice(0, 300)}`,
      };
    }
    return {
      status: "retryable",
      reason: `${object} ${String(response.status)}: ${text.slice(0, 300)}`,
    };
  }
}

/**
 * "Priya Raghavan" → first "Priya", last "Raghavan". "Priya" → last "Priya".
 *
 * Last space rather than first, so "Mei Lin Chen" keeps "Mei Lin" together.
 * Salesforce requires a last name; a public form that demanded one would cost
 * more enquiries than the tidiness is worth.
 */
export function splitName(full: string): { firstName: string | null; lastName: string } {
  const trimmed = full.trim().replace(/\s+/g, " ");
  if (trimmed === "") return { firstName: null, lastName: "Unknown" };
  const cut = trimmed.lastIndexOf(" ");
  if (cut === -1) return { firstName: null, lastName: trimmed };
  return { firstName: trimmed.slice(0, cut), lastName: trimmed.slice(cut + 1) };
}
