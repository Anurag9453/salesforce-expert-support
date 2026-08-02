import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { can } from "@sfx/domain";
import { Alert, Card, CardBody, CardHeader, CardTitle } from "@/components/ui";
import { requireActor } from "@/lib/session";

export const metadata: Metadata = { title: "Expert workspace" };
export const dynamic = "force-dynamic";

/**
 * Expert workspace.
 *
 * Gated on an APPROVED application, not on the EXPERT role (requirement 2).
 * A user holding the role with a DRAFT or SUSPENDED application is redirected
 * back to their application — server-side, before anything renders.
 *
 * The workspace itself is thin by design: the availability toggle is Phase 4,
 * incoming requests are Phase 6, earnings are Phase 9.
 */
export default async function ExpertWorkspacePage() {
  const actor = await requireActor();
  if (!can(actor, "expert_workspace:access")) {
    redirect(actor.expert ? "/expert-application" : "/dashboard");
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Expert workspace</h1>
        <p className="mt-1 text-sm text-ink-muted">Your application is approved.</p>
      </header>

      <Alert tone="info" title="Not yet receiving requests">
        Approval makes you eligible. Actually being matched also needs the availability toggle
        (Phase 4) and the dispatch loop (Phase 6).
      </Alert>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Availability</CardTitle>
          </CardHeader>
          <CardBody>
            <p className="text-sm text-ink-muted">Phase 4.</p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Incoming requests</CardTitle>
          </CardHeader>
          <CardBody>
            <p className="text-sm text-ink-muted">Phase 6.</p>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
