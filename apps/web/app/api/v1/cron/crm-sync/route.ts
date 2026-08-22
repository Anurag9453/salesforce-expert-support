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
