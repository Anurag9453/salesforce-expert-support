import { NextResponse } from "next/server";
import { getContainer } from "@/lib/container";
import { serverEnv } from "@/lib/env";

export const dynamic = "force-dynamic";
// The signature is computed over the exact bytes Stripe sent. Any parsing,
// re-encoding or body-size middleware in front of this breaks verification, so
// the raw text is read directly.
export const runtime = "nodejs";

/**
 * Stripe webhooks.
 *
 * This endpoint is public by necessity — Stripe has no session — which makes the
 * signature the only thing standing between a stranger and a free session.
 * Nothing is read from the body until `parseWebhook` has verified it, and an
 * unverified request gets a flat 400 with no detail: a hostile caller learns
 * nothing about why it failed.
 *
 * ## Why events are recorded before they are acted on
 *
 * Stripe retries. It retries on timeouts, on non-2xx, and sometimes simply
 * because it delivered at-least-once. So the same event will arrive more than
 * once, and the handler must be safe to run twice.
 *
 * The `WebhookEvent` table has a unique constraint on the provider's event id.
 * We insert first: if the insert conflicts, this event has already been seen and
 * we return 200 without doing the work again. That makes idempotency a database
 * invariant rather than an application check with a race in the middle.
 *
 * ## Why it answers 200 to things it ignores
 *
 * An unrecognised event type is not an error. Returning anything else makes
 * Stripe retry it forever and eventually disable the endpoint — taking the
 * events we *do* care about down with it.
 */
export async function POST(request: Request) {
  const env = serverEnv();
  if (env.PAYMENT_PROVIDER !== "stripe") {
    // Nothing is listening. Say so plainly rather than pretending to accept it.
    return NextResponse.json(
      { ok: false, error: "stripe is not the active provider" },
      { status: 404 },
    );
  }

  const rawBody = await request.text();
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const { paymentWebhooks } = getContainer();
  const result = await paymentWebhooks.accept(rawBody, headers);

  if (!result) {
    // Deliberately terse. A signature failure is either misconfiguration or an
    // attack, and neither deserves a helpful error message.
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  if (result.duplicate) {
    // Stripe is retrying a delivery we have already stored. Acknowledge so it
    // stops, and do nothing twice.
    return NextResponse.json({ ok: true, duplicate: true });
  }

  /*
    Deliberately only recorded, not yet acted on.

    The state transitions these should drive — capture confirmed, payment failed,
    refund settled — belong to the payment lifecycle that does not exist yet, and
    a handler that half-transitions a request would be worse than one that
    faithfully records what happened and waits. The row is durable, so nothing is
    lost by acting on it later.
  */
  return NextResponse.json({ ok: true });
}
