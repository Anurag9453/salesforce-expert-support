"use client";

import type { RequestView } from "@sfx/contracts";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Alert, Badge, Button } from "@/components/ui";

/**
 * Live status for an in-flight request (§6, §38).
 *
 * Phase 6 replaces the polling here with realtime. Until then this refreshes on
 * an interval, which is honest for a status page and is explicitly not the
 * dispatch mechanism — §17 rules out polling for dispatch, not for a customer
 * watching their own request.
 *
 * It stops polling as soon as the request reaches a state that will not change
 * on its own, so an abandoned tab does not sit hitting the server all day.
 */

const LIVE_STATES = new Set(["CREATED", "CLASSIFYING", "SEARCHING", "OFFERED"]);

const NARRATIVE: Record<
  string,
  { headline: string; detail: string; tone: "info" | "success" | "warning" | "danger" }
> = {
  CREATED: {
    headline: "Request received",
    detail: "Getting started…",
    tone: "info",
  },
  CLASSIFYING: {
    headline: "Reading your problem",
    detail: "Working out which Salesforce skills this needs.",
    tone: "info",
  },
  SEARCHING: {
    headline: "Finding the right Salesforce expert…",
    detail: "We're matching you with someone who has the right depth for this.",
    tone: "info",
  },
  OFFERED: {
    headline: "Expert found — waiting for them to accept",
    detail: "We've offered your request to an expert.",
    tone: "info",
  },
  ACCEPTED: { headline: "Expert found.", detail: "Setting up your session.", tone: "success" },
  READY: { headline: "Your session is ready", detail: "Join when you are.", tone: "success" },
  IN_SESSION: { headline: "Session in progress", detail: "", tone: "success" },
  COMPLETED: { headline: "Session complete", detail: "", tone: "success" },
  NO_EXPERT_FOUND: {
    headline: "We couldn't find the right expert",
    detail:
      "Rather than connect you with someone who isn't a good fit, we've stopped and released your payment authorization. Nothing has been charged.",
    tone: "warning",
  },
  CANCELLED: {
    headline: "Request cancelled",
    detail: "Your payment authorization has been released. Nothing was charged.",
    tone: "warning",
  },
};

export function RequestStatus({ initial }: { initial: RequestView }) {
  const router = useRouter();
  const [request, setRequest] = useState(initial);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const live = LIVE_STATES.has(request.state);

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(async () => {
      const response = await fetch(`/api/v1/requests/${request.id}`);
      const body = await response.json();
      if (body.ok) setRequest(body.data);
    }, 3000);
    return () => clearInterval(timer);
  }, [live, request.id]);

  const narrative = NARRATIVE[request.state] ?? {
    headline: request.state,
    detail: "",
    tone: "info" as const,
  };

  async function cancel() {
    setCancelling(true);
    setError(null);
    const response = await fetch(`/api/v1/requests/${request.id}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = await response.json();
    if (!body.ok) {
      setError(body.error.message);
      setCancelling(false);
      return;
    }
    setRequest(body.data);
    setCancelling(false);
    router.refresh();
  }

  const aiSkills = request.skills.filter((s) => s.source === "AI_DETECTED");
  const customerSkills = request.skills.filter((s) => s.source === "CUSTOMER_SELECTED");

  return (
    <div className="space-y-5">
      {error && <Alert tone="danger">{error}</Alert>}

      <Alert tone={narrative.tone} title={narrative.headline}>
        <div className="space-y-2">
          {narrative.detail && <p>{narrative.detail}</p>}
          {live && (
            <p className="flex items-center gap-2 text-xs text-ink-subtle">
              <span
                className="inline-block size-1.5 animate-pulse rounded-full bg-accent"
                aria-hidden="true"
              />
              Updating automatically
              {request.secondsUntilDeadline > 0 &&
                ` · about ${Math.ceil(request.secondsUntilDeadline / 60)} min left in the matching window`}
            </p>
          )}
        </div>
      </Alert>

      {/*
        What the classifier concluded, shown plainly. The customer never had to
        get this right themselves (requirement 2), so showing our reading of
        their problem is both reassuring and a chance for them to notice we
        misread it.
      */}
      {aiSkills.length > 0 && (
        <section className="rounded-lg border border-border bg-surface-raised p-4">
          <h2 className="text-sm font-semibold text-ink">What we think this is about</h2>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {aiSkills.map((skill) => (
              <Badge key={skill.slug} tone={skill.isPrimary ? "accent" : "neutral"}>
                {skill.name}
                {skill.isPrimary ? " · main" : ""}
              </Badge>
            ))}
          </div>
          {request.difficulty && (
            <p className="mt-2.5 text-xs text-ink-subtle">
              Assessed as {request.difficulty.toLowerCase()}
              {request.aiModel ? ` by ${request.aiModel}` : ""}.
            </p>
          )}
        </section>
      )}

      {aiSkills.length === 0 && customerSkills.length > 0 && (
        <section className="rounded-lg border border-border bg-surface-raised p-4">
          <h2 className="text-sm font-semibold text-ink">Matching on what you told us</h2>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {customerSkills.map((skill) => (
              <Badge key={skill.slug}>{skill.name}</Badge>
            ))}
          </div>
        </section>
      )}

      {request.cancellable && (
        <div className="flex items-center gap-3">
          <Button variant="secondary" onClick={() => void cancel()} disabled={cancelling}>
            {cancelling ? "Cancelling…" : "Cancel request"}
          </Button>
          <span className="text-xs text-ink-subtle">
            You can cancel any time before an expert accepts.
          </span>
        </div>
      )}
    </div>
  );
}
