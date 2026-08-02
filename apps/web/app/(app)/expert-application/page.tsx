import type { Metadata } from "next";
import Link from "next/link";
import { can, isDomainError } from "@sfx/domain";
import { Alert, Card, CardBody, ExpertStatusBadge } from "@/components/ui";
import { ExpertApplicationForm } from "@/components/expert/application-form";
import { StartApplication } from "@/components/expert/start-application";
import { getContainer } from "@/lib/container";
import { toExpertApplicationView } from "@/lib/expert-view";
import { requireActor } from "@/lib/session";

export const metadata: Metadata = { title: "Expert application" };
export const dynamic = "force-dynamic";

/**
 * The applicant's view of their own application.
 *
 * Everything shown here is authorized server-side by the service call itself —
 * `getOwn` throws for anyone it does not belong to, so the page cannot render
 * someone else's application even if the URL is guessed.
 */
export default async function ExpertApplicationPage() {
  const actor = await requireActor();

  if (!actor.expert) {
    return <StartApplication />;
  }

  const { expertApplications } = getContainer();

  let view;
  try {
    view = toExpertApplicationView(await expertApplications.getOwn(actor));
  } catch (error) {
    if (isDomainError(error)) {
      return <Alert tone="danger">{error.message}</Alert>;
    }
    throw error;
  }

  // Mirrors the policy; the server enforces it regardless of what renders.
  const readOnly = !can(actor, "expert_application:update_own");

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">Expert application</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Approval is what makes you eligible for matching — not the expert role itself.
          </p>
        </div>
        <ExpertStatusBadge status={view.status} />
      </header>

      {view.status === "SUBMITTED" || view.status === "UNDER_REVIEW" ? (
        <Alert tone="info" title="With our team">
          We are reviewing your application. It is locked while we do — you will be able to edit it
          again if we come back with changes.
        </Alert>
      ) : null}

      {view.status === "APPROVED" ? (
        <Alert tone="success" title="Approved">
          You can be matched with customers once you go available.{" "}
          <Link href="/expert" className="underline">
            Open your workspace
          </Link>
          .
        </Alert>
      ) : null}

      {/*
        Skills are what a reviewer assesses, so they are editable from the moment
        an application exists — long before approval gates availability.
      */}
      <Alert tone="info" title="Your skills are part of this application">
        <Link href="/expert/skills" className="underline">
          Add the Salesforce skills you want to be matched on
        </Link>
        , with an honest depth rating for each.
      </Alert>

      {view.status === "SUSPENDED" ? (
        <Alert tone="warning" title="Suspended">
          {view.reviewNotes ?? "Contact support for details."}
        </Alert>
      ) : null}

      <Card>
        <CardBody className="p-0">
          <div className="p-5">
            <ExpertApplicationForm application={view} readOnly={readOnly} />
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
