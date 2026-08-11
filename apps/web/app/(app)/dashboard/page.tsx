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
  PageHeader,
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

/** States where something is actively happening, so the badge should pulse. */
const LIVE_STATES = new Set(["CREATED", "CLASSIFYING", "SEARCHING", "OFFERED", "IN_SESSION"]);

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
      <PageHeader
        eyebrow="Your account"
        title={active ? "You have help on the way" : "What can we help with?"}
        meta={actor.roles.map((role) => (
          <Badge key={role} tone={role === "ADMIN" ? "warning" : "neutral"} dot>
            {role.toLowerCase()}
          </Badge>
        ))}
      />

      {/*
        The hero slot. One card, full width, carrying whichever of the two states
        the customer is actually in — never both, and never a request form
        sitting next to a live request.
      */}
      {active ? (
        <Card accent className="animate-scale-in overflow-hidden">
          <CardBody className="flex flex-wrap items-center justify-between gap-x-8 gap-y-5 p-6">
            <div className="min-w-0 flex-1">
              <Badge
                tone="accent"
                pulse={LIVE_STATES.has(active.state)}
                dot={!LIVE_STATES.has(active.state)}
              >
                {ACTIVE_COPY[active.state] ?? active.state.replace(/_/g, " ").toLowerCase()}
              </Badge>
              <p className="font-display mt-3 truncate text-xl font-medium text-ink">
                {active.title}
              </p>
            </div>
            <Link href={`/request/${active.id}`} className={buttonClasses({ size: "lg" })}>
              View request
            </Link>
          </CardBody>
        </Card>
      ) : (
        <Card accent className="animate-scale-in">
          <CardBody className="p-6 sm:p-8">
            <h2 className="font-display max-w-lg text-2xl leading-snug font-medium text-balance text-ink">
              Describe your problem in your own words.
            </h2>
            <p className="mt-3 max-w-lg text-sm leading-relaxed text-ink-muted">
              We&rsquo;ll match you with an expert who has the right depth, usually within 15
              minutes. You never have to pick one.
            </p>
            <Link href="/request-help" className={buttonClasses({ size: "lg", className: "mt-6" })}>
              Get Expert Help
            </Link>
          </CardBody>
        </Card>
      )}

      <div className="stagger grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent requests</CardTitle>
            {history.length > 0 && (
              <Link
                href="/requests"
                className="interactive ml-auto text-xs text-accent hover:underline"
              >
                See all
              </Link>
            )}
          </CardHeader>
          <CardBody>
            {history.length === 0 ? (
              <p className="py-2 text-sm text-ink-muted">
                Nothing yet. Your past requests will appear here.
              </p>
            ) : (
              <ul className="-mx-2 divide-y divide-border">
                {history.slice(0, 4).map((request) => (
                  <li key={request.id} className="first:-mt-2 last:-mb-2">
                    <Link
                      href={`/request/${request.id}`}
                      className="interactive flex items-center gap-3 rounded-md px-2 py-2.5 hover:bg-surface-sunken"
                    >
                      <span className="truncate text-sm text-ink">{request.title}</span>
                      <span className="ml-auto shrink-0 text-xs text-ink-subtle">
                        {request.state.replace(/_/g, " ").toLowerCase()}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{expert ? "Your expert application" : "Become an expert"}</CardTitle>
          </CardHeader>
          <CardBody className="space-y-4">
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
                <p className="text-sm leading-relaxed text-ink-muted">
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
