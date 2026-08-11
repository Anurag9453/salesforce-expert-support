import { createRequestSchema, DEFAULT_CURRENCY } from "@sfx/contracts";
import { describeFindings, RATE_LIMITS } from "@sfx/domain";
import { apiOk, handleRoute, parseBody } from "@/lib/route-helpers";
import { getContainer } from "@/lib/container";
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
