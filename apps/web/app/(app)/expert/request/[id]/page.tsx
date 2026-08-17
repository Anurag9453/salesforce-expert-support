import { can, isDomainError } from "@sfx/domain";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { OfferPanel } from "@/components/expert/offer-panel";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, PageHeader } from "@/components/ui";
import { formatMoney } from "@/lib/format";
import { toOfferView } from "@/lib/matching-view";
import { getContainer } from "@/lib/container";
import { requireActor } from "@/lib/session";

export const metadata: Metadata = { title: "Request" };
export const dynamic = "force-dynamic";

/**
 * One request, as the expert who was offered it may see it.
 *
 * This is where a notification lands. Sending them to `/expert` instead was
 * wrong in a specific way: by the time an expert opens a notification the
 * workspace may be showing a *different* offer, or none, so the one thing the
 * notification was about is the one thing they could not see.
 *
 * Authorization is the lookup, not a check layered on top: an expert with no
 * attempt on this request gets a 404 identical to a request that does not exist.
 * A distinct "forbidden" would confirm the id was real and turn this page into a
 * way to enumerate other people's requests.
 *
 * The content is exactly what the offer carried — already redacted at intake, no
 * customer identity, and no score or rank. Opening an old notification must not
 * reveal more than the live offer did.
 */

/** Past tense, and specific about who ended it. Vagueness here reads as a bug. */
const OUTCOME: Record<
  string,
  { tone: "info" | "success" | "warning" | "danger"; title: string; body: string }
> = {
  ACCEPTED: {
    tone: "success",
    title: "You took this one",
    body: "It is yours. Session setup lands in a later phase — for now this is where the loop ends.",
  },
  DECLINED: {
    tone: "info",
    title: "You declined this",
    body: "It went to another expert. Declining does not count against you the way letting one lapse does.",
  },
  TIMED_OUT: {
    tone: "warning",
    title: "This one lapsed",
    body: "The window closed before you answered, so it moved on to the next expert. Declining is always better than letting it run out.",
  },
  WITHDRAWN: {
    tone: "info",
    title: "This was withdrawn",
    body: "The offer was pulled before you answered — the request was reassigned, cancelled, or you went offline.",
  },
  SUPERSEDED: {
    tone: "info",
    title: "This went to someone else",
    body: "You were ranked for it but another expert accepted first.",
  },
  EXCLUDED: {
    tone: "info",
    title: "You were not offered this",
    body: "It did not match your declared skills closely enough at the time.",
  },
  RANKED: {
    tone: "info",
    title: "Not offered to you yet",
    body: "You are in the running for this one. If it reaches you, it will appear in your workspace.",
  },
};

export default async function ExpertRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requireActor();
  if (!can(actor, "expert_workspace:access")) redirect("/dashboard");

  const { matching, pricing } = getContainer();

  let detail;
  try {
    detail = await matching.requestDetailForExpert(actor, id);
  } catch (error) {
    // NotFound covers both "no such request" and "not yours" on purpose.
    if (isDomainError(error) && error.code === "NOT_FOUND") notFound();
    throw error;
  }

  const { attempt, request } = detail;
  const tier = await pricing.findTierById(request.pricingTierId);
  const durationMinutes = tier?.durationMinutes ?? 30;
  const now = new Date();

  const live = attempt.status === "OFFERED" && (attempt.offerExpiresAt ?? now) > now;
  const outcome = OUTCOME[attempt.status];

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        back={{ href: "/expert", label: "Expert workspace" }}
        eyebrow={live ? "Waiting on you" : "Request"}
        title={request.title}
        meta={
          <>
            {attempt.origin !== "ALGORITHMIC" && (
              <Badge tone="warning">
                {attempt.origin === "ADMIN_FORCE_ASSIGN" ? "Sent by our team" : "Chosen for you"}
              </Badge>
            )}
            <Badge tone={live ? "accent" : "neutral"} pulse={live} dot={!live}>
              {live ? "Open" : attempt.status.replace(/_/g, " ").toLowerCase()}
            </Badge>
          </>
        }
      />

      {/*
        Still open, so give them the real thing rather than a read-only copy of
        it. The panel owns the countdown, the accept/decline calls and the
        realtime reconcile — duplicating any of that here would be a second
        implementation of the most consequential screen in the product.
      */}
      {live ? (
        <OfferPanel initial={toOfferView({ attempt, request, durationMinutes, now })} />
      ) : (
        outcome && (
          <Alert tone={outcome.tone} title={outcome.title}>
            {outcome.body}
          </Alert>
        )
      )}

      <Card>
        <CardHeader>
          <CardTitle>What the customer told us</CardTitle>
        </CardHeader>
        <CardBody className="space-y-4">
          <p className="text-sm leading-relaxed whitespace-pre-wrap text-ink">
            {request.description}
          </p>

          <div className="flex flex-wrap items-center gap-1.5">
            {request.skills
              .filter((skill) => skill.isPrimary)
              .map((skill) => (
                <Badge key={skill.slug} tone="accent" title="The core skill this needs">
                  {skill.name}
                </Badge>
              ))}
            {request.skills
              .filter((skill) => !skill.isPrimary)
              .map((skill) => (
                <Badge key={skill.slug}>{skill.name}</Badge>
              ))}
            {request.difficulty && <Badge>{request.difficulty.toLowerCase()}</Badge>}
          </div>

          <dl className="grid grid-cols-2 gap-4 border-t border-border pt-4 sm:grid-cols-3">
            <div>
              <dt className="eyebrow text-ink-subtle">Session</dt>
              <dd data-numeric className="font-display mt-0.5 text-lg font-medium text-ink">
                {durationMinutes} min
              </dd>
            </div>
            <div>
              <dt className="eyebrow text-ink-subtle">{live ? "You earn" : "Would have earned"}</dt>
              <dd data-numeric className="font-display mt-0.5 text-lg font-medium text-available">
                {/* Their payout, never the customer's price. */}
                {formatMoney(request.quotedExpertPayoutCents, request.currency)}
              </dd>
            </div>
            {attempt.offeredAt && (
              <div>
                <dt className="eyebrow text-ink-subtle">Offered</dt>
                <dd className="mt-0.5 text-sm text-ink">
                  <time dateTime={attempt.offeredAt.toISOString()}>
                    {attempt.offeredAt.toLocaleString()}
                  </time>
                </dd>
              </div>
            )}
          </dl>
        </CardBody>
      </Card>

      {attempt.origin !== "ALGORITHMIC" && attempt.adminReason && (
        <Alert tone="info" title="A note from our team">
          {attempt.adminReason}
        </Alert>
      )}
    </div>
  );
}
