import type { WorkerContainer } from "../container.js";

export interface CrmSyncPayload {
  leadId: string;
}

/**
 * Get one captured enquiry into Salesforce.
 *
 * The job exists so that the customer's "we'll get back to you" never depends on
 * Salesforce being reachable. The lead is already durable by the time this runs;
 * all that is at stake here is how quickly a human hears about it.
 *
 * Failure handling is split deliberately, and the service decides which is which:
 *
 *   - **retryable** (timeout, 5xx, rate limit, expired session) throws, and the
 *     job runner backs off and tries again — eight times over roughly an hour.
 *   - **rejected** (a validation rule, a required field the org has and we do
 *     not) returns normally. Retrying cannot fix it, and a job that keeps
 *     failing buries the enquiry in a queue instead of putting the reason on the
 *     row where somebody can see it.
 */
export async function handleCrmSync(
  container: WorkerContainer,
  payload: CrmSyncPayload,
): Promise<void> {
  const result = await container.supportLeads.syncToCrm(payload.leadId);

  container.logger.info("crm sync", {
    job: "crm-sync",
    leadId: payload.leadId,
    status: result.status,
  });
}

/**
 * Sweeps enquiries that never reached the CRM.
 *
 * A backstop for a lost job, in the same spirit as the offer and confirmation
 * reconcilers. The failure it guards against is the quietest one in the product:
 * an enquiry sitting in the database that nobody is ever told about.
 */
export async function retryUnsyncedLeads(container: WorkerContainer): Promise<void> {
  const { attempted } = await container.supportLeads.retryUnsynced();
  if (attempted > 0) {
    container.logger.warn("re-queued enquiries that had not reached the CRM", { attempted });
  }
}
