import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getContainer } from "@/lib/container";
import { serverEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Retries enquiries that never reached the CRM.
 *
 * The push happens inline when a lead is submitted, so this is a net rather than
 * the mechanism. It exists for the cases that net has to catch: Salesforce was
 * down for a minute, the access token had expired in a way the retry did not
 * cover, or the function was torn down before `after` finished.
 *
 * It calls the reconciler that already exists — `SupportLeadService.retryUnsynced`
 * — which is the same code path the worker's sweep uses. There is deliberately no
 * second implementation of "find the stuck ones and try again".
 *
 * ## Why daily and not hourly
 *
 * `vercel.json` schedules this once a day, not once an hour as first written. Hobby
 * accounts only permit daily cron expressions, and Vercel rejects the *deployment*
 * — not the cron — when it sees a more frequent one, so the hourly schedule silently
 * stopped every push from building for a month. Daily is the cadence this plan
 * allows, and a lead the inline push dropped now waits up to a day rather than an
 * hour. That is the cost of the net being cheap; the inline push is still the
 * mechanism. Pro lifts the limit, and an external scheduler calling this endpoint
 * with `CRON_SECRET` would too.
 *
 * ## Why this is guarded rather than public
 *
 * It is cheap to call and it talks to a third party, so an open endpoint is a way
 * to make us hammer Salesforce for free. `CRON_SECRET` is compared in constant
 * time; Vercel Cron sends it as a bearer token automatically when the variable is
 * set on the project.
 *
 * Returns 404 rather than 401 when the secret is not configured at all. A route
 * that announces "you guessed wrong" is a route worth guessing at.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const expected = serverEnv().CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ ok: false, error: { code: "NOT_FOUND" } }, { status: 404 });
  }

  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Length must match before timingSafeEqual, and comparing lengths first leaks
  // only the length — which an attacker already knows if they chose the input.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ ok: false, error: { code: "UNAUTHENTICATED" } }, { status: 401 });
  }

  const { supportLeads, logger } = getContainer();
  /*
    `syncPendingToCrm`, not `retryUnsynced`. The latter enqueues a durable job,
    which is right when a worker is draining the queue and pointless when there is
    not one — the job would be written and never read, which is the failure this
    route exists to fix.
  */
  const result = await supportLeads.syncPendingToCrm();

  logger.info("crm reconcile ran", result);
  return NextResponse.json({ ok: true, data: result });
}
