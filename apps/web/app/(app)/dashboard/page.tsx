import type { Metadata } from "next";
import Link from "next/link";
import { can, isEligibleForMatching } from "@sfx/domain";
import {
  Badge,
  Button,
  buttonClasses,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  ExpertStatusBadge,
} from "@/components/ui";
import { requireActor } from "@/lib/session";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

/**
 * Customer dashboard.
 *
 * Deliberately thin: "Request Expert Help", active requests and session history
 * are Phase 3. What Phase 2 owns is the account itself and the route into
 * becoming an expert.
 */
export default async function DashboardPage() {
  const actor = await requireActor();
  const expert = actor.expert;
  const hasWorkspace = can(actor, "expert_workspace:access");

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Your account</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {actor.roles.map((role) => (
            <Badge key={role} tone={role === "ADMIN" ? "warning" : "neutral"}>
              {role.toLowerCase()}
            </Badge>
          ))}
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Get Salesforce help</CardTitle>
          </CardHeader>
          <CardBody className="space-y-3">
            <p className="text-sm text-ink-muted">
              Describe your problem and we match you with an expert. Ships in Phase 3.
            </p>
            <Button disabled>Get Expert Help</Button>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{expert ? "Your expert application" : "Become an expert"}</CardTitle>
          </CardHeader>
          <CardBody className="space-y-3">
            {expert ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <ExpertStatusBadge status={expert.status} />
                  {/*
                    Requirement 2, said out loud in the UI: the server computed
                    this from the application status, not from holding the role.
                  */}
                  <span className="text-xs text-ink-subtle">
                    {isEligibleForMatching(expert.status)
                      ? "eligible for matching"
                      : "not yet eligible for matching"}
                  </span>
                </div>
                <Link
                  href={hasWorkspace ? "/expert" : "/expert-application"}
                  className={buttonClasses({ variant: "secondary" })}
                >
                  {hasWorkspace ? "Expert workspace" : "View application"}
                </Link>
              </>
            ) : (
              <>
                <p className="text-sm text-ink-muted">
                  Apply with this same account — you keep your customer access either way.
                </p>
                <Link
                  href="/expert-application"
                  className={buttonClasses({ variant: "secondary" })}
                >
                  Become an Expert
                </Link>
              </>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
