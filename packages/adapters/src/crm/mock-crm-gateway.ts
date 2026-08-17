import type { CrmGateway, CrmLead, CrmPushResult, Logger } from "@sfx/domain";

/**
 * A CRM that records and forwards nothing.
 *
 * The default, and a runnable demonstration rather than a stub: with this
 * installed the enquiry is still captured, still durable, and still shown to the
 * customer as received — only the push to Salesforce is absent. That is the
 * property the whole design rests on, so it is worth being able to run it.
 *
 * It also keeps tests and CI away from a real org. A test suite that creates
 * Leads in someone's Salesforce is a test suite that eventually creates a
 * thousand of them.
 */
export class MockCrmGateway implements CrmGateway {
  readonly name = "mock";
  /** Everything it was asked to push, so a test can assert on it. */
  readonly pushed: CrmLead[] = [];

  constructor(private readonly logger?: Logger) {}

  async pushLead(lead: CrmLead): Promise<CrmPushResult> {
    this.pushed.push(lead);
    this.logger?.info("mock CRM accepted a lead", {
      leadId: lead.idempotencyKey,
      // Not the summary, the email or the phone number. A log line is not a
      // safe place for someone's contact details, and this one exists only to
      // show the path ran.
      durationMinutes: lead.durationMinutes,
    });
    return { status: "created", recordId: `mock_${lead.idempotencyKey}` };
  }
}
