import { authorize, type Actor } from "../authorization/index.js";
import type { SupportLeadRecord, SupportLeadRepository } from "../ports/request-repositories.js";
import { ValidationError } from "../shared/errors.js";

/**
 * Long-term support, which is not a product yet.
 *
 * The entry screen offers it as one of two choices, so something has to catch
 * the enquiry. This is that: authorize, require a customer profile, store the
 * summary. There is deliberately no pricing, no matching and no state machine —
 * building a workflow for a product nobody has designed would be worse than the
 * honest gap.
 *
 * The caller redacts before handing the summary over, exactly as request intake
 * does. This service does not scan, so that the ordering rule — redact before
 * anything is stored — has one owner rather than two implementations.
 */
export class SupportLeadService {
  constructor(private readonly deps: { leads: SupportLeadRepository }) {}

  async create(actor: Actor, input: { summary: string }): Promise<SupportLeadRecord> {
    authorize(actor, "support_request:create");

    // Reusing the request permission rather than minting a lead-specific one:
    // anyone who may ask for help may ask for the long-term version of it, and
    // a second permission with identical holders is a permission that will drift.
    if (!actor.customerProfileId) {
      throw new ValidationError("You need a customer profile before you can ask for help.", {
        customer: ["missing"],
      });
    }

    return this.deps.leads.create({
      customerId: actor.customerProfileId,
      summary: input.summary,
    });
  }
}
