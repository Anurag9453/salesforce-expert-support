import { createSupportLeadSchema } from "@sfx/contracts";
import { RATE_LIMITS, scanForSecrets } from "@sfx/domain";
import { apiOk, handleRoute, parseBody } from "@/lib/route-helpers";
import { getContainer } from "@/lib/container";
import { enforceRateLimit } from "@/lib/rate-limit";
import { requireActor } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Capture a long-term-support enquiry.
 *
 * Long-term support is not a product yet, so this deliberately does almost
 * nothing: it records that someone asked, and returns. No pricing, no matching,
 * no state machine — see the `SupportLead` comment in the schema for why
 * inventing a workflow here would be worse than an empty table.
 *
 * The one thing it does share with a real request is redaction. The same
 * prohibition on credentials and production data applies to anything a customer
 * types into this platform, and a field that skipped it would be the obvious
 * place for a secret to land (§31 — redact before anything is stored).
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const actor = await requireActor();

    const limited = await enforceRateLimit(`user:${actor.userId}`, RATE_LIMITS.REQUEST_CREATE);
    if (limited) return limited;

    const body = await parseBody(request, createSupportLeadSchema);
    if (!body.ok) return body.response;

    const { supportLeads } = getContainer();
    const scan = scanForSecrets(body.data.summary);
    const lead = await supportLeads.create(actor, { summary: scan.redacted });

    return apiOk({ lead }, 201);
  });
}
