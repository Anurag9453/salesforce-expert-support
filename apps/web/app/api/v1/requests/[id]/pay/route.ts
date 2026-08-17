import { getContainer } from "@/lib/container";
import { apiOk, handleRoute } from "@/lib/route-helpers";
import { requireActor } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * What the customer owes on this request, if anything.
 *
 * Safe in every state, so the page can ask without first working out whether
 * asking makes sense.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { id } = await params;
    return apiOk(await getContainer().checkout.summary(actor, id));
  });
}

/**
 * Pay, and open the session.
 *
 * There is deliberately **no body**. The amount comes from the request's own
 * quoted price, and a price that arrives in a request body is a price the
 * customer can choose — so there is nothing here for a caller to supply.
 *
 * The gateway in this build is the mock one: no card is collected and no money
 * moves. The shape is real, so the provider drops in behind this route without
 * the flow changing.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { id } = await params;
    const payment = await getContainer().checkout.pay(actor, id);

    return apiOk({
      status: payment.status,
      amountCents: payment.amountCents,
      currency: payment.currency,
      // Never the provider reference: it is an internal handle, and echoing it
      // to the browser invites someone to try using it.
      paidAt: payment.authorizedAt?.toISOString() ?? null,
    });
  });
}
