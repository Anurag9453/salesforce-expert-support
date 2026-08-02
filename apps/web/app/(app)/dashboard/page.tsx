import type { Metadata } from "next";
import Link from "next/link";
import { can, isEligibleForMatching } from "@sfx/domain";
import {
  Badge,
  buttonClasses,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  ExpertStatusBadge,
} from "@/components/ui";
import { getContainer } from "@/lib/container";
import { requireActor } from "@/lib/session";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

const ACTIVE_COPY: Record<string, string> = {
  CREATED: "Just received",
  CLASSIFYING: "Reading your problem",
  SEARCHING: "Finding the right expert…",
  OFFERED: "Expert found — waiting for them to accept",
  ACCEPTED: "Expert found",
  READY: "Your session is ready",
  IN_SESSION: "Session in progress",
};

/**
 * Customer dashboard (§6).
 *
 * "Get Expert Help" is the single most prominent thing on the page, per §6, and
 * it becomes the live request card the moment one exists — a customer with a
 * request in flight wants its status, not an invitation to raise another.
 */
export default async function DashboardPage() {
  const actor = await requireActor();
  const { supportRequests } = getContainer();

  const [active, recent] = await Promise.all([
    supportRequests.findActive(actor),
    supportRequests.listForCustomer(actor, { limit: 5 }),
  ]);

  const expert = actor.expert;
  const hasWorkspace = can(actor, "expert_workspace:access");
  const history = recent.items.filter((request) => request.id !== active?.id);

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

      {active ? (
        <Card>
          <CardHeader>
            <CardTitle>Request in progress</CardTitle>
          </CardHeader>
          <CardBody className="space-y-3">
            <p className="text-sm font-medium text-ink">{active.title}</p>
            <p className="text-sm text-ink-muted">
              {ACTIVE_COPY[active.state] ?? active.state.replace(/_/g, " ").toLowerCase()}
            </p>
            <Link href={`/request/${active.id}`} className={buttonClasses({ size: "md" })}>
              View request
            </Link>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Get Salesforce help</CardTitle>
          </CardHeader>
          <CardBody className="space-y-3">
            <p className="text-sm text-ink-muted">
              Describe your problem in your own words. We&rsquo;ll match you with an expert who has
              the right depth, usually within 15 minutes.
            </p>
            <Link href="/request-help" className={buttonClasses({ size: "lg" })}>
              Get Expert Help
            </Link>
          </CardBody>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent requests</CardTitle>
          </CardHeader>
          <CardBody className="space-y-2.5">
            {history.length === 0 ? (
              <p className="text-sm text-ink-muted">Nothing yet.</p>
            ) : (
              <>
                <ul className="space-y-2">
                  {history.slice(0, 4).map((request) => (
                    <li key={request.id}>
                      <Link
                        href={`/request/${request.id}`}
                        className="flex items-center gap-2 text-sm hover:underline"
                      >
                        <span className="truncate text-ink">{request.title}</span>
                        <span className="ml-auto shrink-0 text-xs text-ink-subtle">
                          {request.state.replace(/_/g, " ").toLowerCase()}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
                <Link href="/requests" className="inline-block text-xs text-accent hover:underline">
                  See all
                </Link>
              </>
            )}
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
                    Requirement 2, said out loud: the server computed this from
                    the application status, not from holding the role.
                  */}
                  <span className="text-xs text-ink-subtle">
                    {isEligibleForMatching(expert.status)
                      ? "eligible for matching"
                      : "not yet eligible for matching"}
                  </span>
                </div>
                <Link
                  href={hasWorkspace ? "/expert" : "/expert-application"}
                  className={buttonClasses({ variant: "secondary", size: "sm" })}
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
                  className={buttonClasses({ variant: "secondary", size: "sm" })}
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
