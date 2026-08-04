import { canGoAvailable, can } from "@sfx/domain";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AvailabilityPanel } from "@/components/expert/availability-panel";
import { AlertSettings } from "@/components/expert/alert-settings";
import { OfferPanel } from "@/components/expert/offer-panel";
import {
  Alert,
  Badge,
  buttonClasses,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
} from "@/components/ui";
import { toAvailabilityLogView, toAvailabilityView } from "@/lib/availability-view";
import { toOfferView } from "@/lib/matching-view";
import { getContainer } from "@/lib/container";
import { requireActor } from "@/lib/session";

export const metadata: Metadata = { title: "Expert workspace" };
export const dynamic = "force-dynamic";

const SOURCE_COPY: Record<string, string> = {
  MANUAL_TOGGLE: "You changed it",
  HEARTBEAT_TIMEOUT: "We stopped hearing from your browser",
  OFFER_LOCK: "A request was offered to you",
  OFFER_RELEASED: "The offer ended",
  SESSION_START: "A session started",
  SESSION_END: "A session ended",
  ADMIN: "Changed by an administrator",
};

/**
 * Expert workspace.
 *
 * Gated on an APPROVED application, not on the EXPERT role (Phase 2,
 * requirement 2). Everything the page shows about eligibility is computed by the
 * server; the page passes verdicts down, never ingredients.
 */
export default async function ExpertWorkspacePage() {
  const actor = await requireActor();
  if (!can(actor, "expert_workspace:access")) {
    redirect(actor.expert ? "/expert-application" : "/dashboard");
  }

  const { expertAvailability, expertSkills, matchingRepo, requests, pricing, clock } =
    getContainer();
  const [availability, skills, history, openOffer] = await Promise.all([
    expertAvailability.getOwn(actor),
    expertSkills.listOwn(actor),
    expertAvailability.history(actor, 10),
    actor.expert ? matchingRepo.findOpenOfferForExpert(actor.expert.profileId) : null,
  ]);

  // Server-rendered so an expert who reloads mid-offer sees the countdown
  // already running, at the right number, rather than a blank card that fills
  // in a poll later.
  const offerRequest = openOffer ? await requests.findById(openOffer.supportRequestId) : null;
  const offerTier = offerRequest ? await pricing.findTierById(offerRequest.pricingTierId) : null;
  const offer =
    openOffer && offerRequest
      ? toOfferView({
          attempt: openOffer,
          request: offerRequest,
          durationMinutes: offerTier?.durationMinutes ?? 30,
          now: clock.now(),
        })
      : null;

  const verified = skills.filter((skill) => skill.verified).length;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Expert workspace</h1>
        <p className="mt-1 text-sm text-ink-muted">{actor.email}</p>
      </header>

      <AvailabilityPanel
        initial={toAvailabilityView(availability)}
        canGoAvailable={canGoAvailable(actor.expert?.status ?? "DRAFT")}
      />

      <AlertSettings />

      <OfferPanel initial={offer} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="flex items-center justify-between gap-3">
            <CardTitle>Your skills</CardTitle>
            <Link
              href="/expert/skills"
              className={buttonClasses({ variant: "secondary", size: "sm" })}
            >
              Manage
            </Link>
          </CardHeader>
          <CardBody className="space-y-3">
            {skills.length === 0 ? (
              // Not decoration — an expert with no skills is invisible to
              // matching, so this is the single most important thing on the page
              // for someone in that state.
              <Alert tone="warning" title="No skills listed">
                We match on skills. Until you list at least one, no request can reach you.
              </Alert>
            ) : (
              <>
                <p className="text-sm text-ink-muted">
                  {skills.length} listed
                  {verified > 0 ? ` · ${verified} verified by our team` : ""}
                </p>
                <ul className="flex flex-wrap gap-1.5">
                  {skills.slice(0, 8).map((skill) => (
                    <li key={skill.slug}>
                      <Badge tone={skill.verified ? "available" : "neutral"}>
                        {skill.name}
                        {skill.verified ? " ✓" : ""}
                      </Badge>
                    </li>
                  ))}
                  {skills.length > 8 && (
                    <li>
                      <Badge>+{skills.length - 8} more</Badge>
                    </li>
                  )}
                </ul>
              </>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader className="flex items-center justify-between gap-3">
            <CardTitle>Your profile</CardTitle>
            <Link
              href="/expert/profile"
              className={buttonClasses({ variant: "secondary", size: "sm" })}
            >
              Edit
            </Link>
          </CardHeader>
          <CardBody>
            <p className="text-sm text-ink-muted">
              Keep your summary, certifications and languages current. Approval status and
              verification are set by our review team and are not editable here.
            </p>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Availability history</CardTitle>
        </CardHeader>
        <CardBody>
          {history.length === 0 ? (
            <p className="text-sm text-ink-muted">Nothing yet.</p>
          ) : (
            // Every change, with its cause. A status that changed on its own is
            // only acceptable if the expert can find out why.
            <ul className="divide-y divide-border text-sm">
              {history.map((entry) => {
                const view = toAvailabilityLogView(entry);
                return (
                  <li key={view.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                    <span className="font-medium text-ink">
                      {view.fromStatus ? `${view.fromStatus} → ` : ""}
                      {view.toStatus}
                    </span>
                    <span className="text-ink-muted">
                      {SOURCE_COPY[view.source] ?? view.source}
                    </span>
                    <time className="ml-auto text-xs text-ink-subtle" dateTime={view.createdAt}>
                      {new Date(view.createdAt).toLocaleString()}
                    </time>
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>

      <Alert tone="info" title="Coming next">
        Accepting an offer is where the Phase 5 loop ends. Realtime notification and sound land in
        Phase 6; the session and video room in Phase 8.
      </Alert>
    </div>
  );
}
