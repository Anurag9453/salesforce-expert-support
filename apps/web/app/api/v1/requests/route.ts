import { createRequestSchema, DEFAULT_CURRENCY } from "@sfx/contracts";
import { describeFindings, RATE_LIMITS } from "@sfx/domain";
import { apiFail, apiOk, handleRoute, parseBody } from "@/lib/route-helpers";
import { getContainer } from "@/lib/container";
import { serverEnv } from "@/lib/env";
import { enforceRateLimit } from "@/lib/rate-limit";
import { toRequestView } from "@/lib/request-view";
import { requireActor } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { supportRequests, attachments, pricing } = getContainer();

    const page = await supportRequests.listForCustomer(actor, { limit: 20 });
    const tiers = await pricing.listActiveTiers(DEFAULT_CURRENCY);
    const durationById = new Map(tiers.map((tier) => [tier.id, tier.durationMinutes]));

    const items = await Promise.all(
      page.items.map(async (request) =>
        toRequestView(
          request,
          await attachments.listForRequest(request.id),
          durationById.get(request.pricingTierId) ?? 30,
        ),
      ),
    );

    return apiOk({ items, nextCursor: page.nextCursor ?? null });
  });
}

/**
 * Create a support request.
 *
 * Rate-limited per user: each request authorizes a payment, so a loop here has
 * a direct financial effect on the customer.
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    /*
      The flag is enforced here, not only in the UI.

      Creating a request is the entry point to everything the current phase does
      not want to run: classification calls the AI provider, and reaching
      SEARCHING starts dispatch, offers and timers. Switching the screen alone
      would leave all of that one stale bookmark or one curl away, and the first
      sign of trouble would be an unexpected bill from Anthropic.
    */
    if (serverEnv().INTAKE_MODE === "lead_capture") {
      return apiFail(
        "CONFLICT",
        "We are taking enquiries rather than instant requests at the moment. Tell us what you need and we will get back to you.",
      );
    }

    const actor = await requireActor();

    const limited = await enforceRateLimit(`user:${actor.userId}`, RATE_LIMITS.REQUEST_CREATE);
    if (limited) return limited;

    const body = await parseBody(request, createRequestSchema);
    if (!body.ok) return body.response;

    const { supportRequests, attachments, pricing } = getContainer();
    const result = await supportRequests.create(actor, body.data);

    const tier = await pricing.findTierById(result.request.pricingTierId);
    const view = toRequestView(
      result.request,
      await attachments.listForRequest(result.request.id),
      tier?.durationMinutes ?? 30,
    );

    return apiOk(
      {
        request: view,
        secretFindings: result.secretFindings.map((finding) => ({
          label: finding.label,
          severity: finding.severity,
          occurrences: finding.occurrences,
        })),
        // Calm, specific, non-accusatory (requirement 5). Null when there is
        // nothing to say, which is the common case.
        secretNotice: describeFindings(result.secretFindings),
      },
      201,
    );
  });
}
