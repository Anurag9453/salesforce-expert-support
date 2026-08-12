"use client";

import type { ShortlistView } from "@sfx/contracts";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, Card, CardBody } from "@/components/ui";
import { ExpertAvatar } from "@/components/expert/expert-avatar";
import { useRealtime } from "@/lib/use-realtime";
import { cn } from "@/lib/utils";

/**
 * The three candidates a customer chooses between.
 *
 * This is the one screen in the product where a customer sees a person rather
 * than an outcome, so two things are load-bearing:
 *
 *   - **No ranking is shown.** The cards carry no score, no rank, and no "best
 *     match" label. The platform already decided who is good enough to appear;
 *     showing the order would turn a choice into a recommendation the customer
 *     feels obliged to follow.
 *   - **Only approved photos.** `photoUrl` is null for no photo, one awaiting
 *     review, and one that was rejected — indistinguishable on purpose, so a
 *     customer cannot infer that someone was refused.
 *
 * Once a candidate is picked the screen becomes a countdown, because from that
 * moment the customer genuinely is waiting on a two-minute deadline.
 */
export function CandidateCards({
  supportRequestId,
  initial,
}: {
  supportRequestId: string;
  initial: ShortlistView;
}) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);

  const reconcile = useCallback(async () => {
    try {
      const response = await fetch(`/api/v1/requests/${supportRequestId}/shortlist`);
      const body = await response.json();
      if (body.ok) setView(body.data as ShortlistView);
    } catch {
      // The fallback poll will retry.
    }
    router.refresh();
  }, [supportRequestId, router]);

  useRealtime(reconcile);

  // Counts down to the stored deadline rather than from 120, so a refresh — or a
  // backgrounded tab that missed ticks — still shows the truth.
  useEffect(() => {
    const deadline = view.awaitingConfirmation?.confirmExpiresAt;
    if (!deadline) {
      setRemaining(null);
      return;
    }
    const target = Date.parse(deadline);
    const tick = () => {
      const left = Math.max(0, Math.ceil((target - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0) void reconcile();
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [view.awaitingConfirmation?.confirmExpiresAt, reconcile]);

  async function choose(attemptId: string) {
    setBusy(attemptId);
    setError(null);
    try {
      const response = await fetch(`/api/v1/requests/${supportRequestId}/shortlist`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attemptId }),
      });
      const body = await response.json();
      if (!body.ok) {
        setError(body.error.message);
        await reconcile();
        return;
      }
      await reconcile();
    } catch {
      setError("Could not reach the server. Check your connection.");
    } finally {
      setBusy(null);
    }
  }

  // ── Waiting on the chosen expert ──────────────────────────────────────────

  if (view.awaitingConfirmation) {
    return (
      <Card accent className="animate-scale-in">
        <CardBody className="space-y-3 p-6 text-center">
          <Badge tone="accent" pulse>
            Waiting for them to confirm
          </Badge>
          <p
            data-numeric
            className={cn(
              "font-display text-4xl leading-none font-medium",
              (remaining ?? 0) <= 30 ? "text-warning" : "text-ink",
            )}
          >
            {remaining ?? "—"}
            <span className="text-xl text-ink-subtle">s</span>
          </p>
          <p className="mx-auto max-w-sm text-sm leading-relaxed text-ink-muted">
            We&rsquo;ve asked them to confirm. If they don&rsquo;t answer in time you can pick
            someone else — you will not lose your place.
          </p>
        </CardBody>
      </Card>
    );
  }

  if (view.candidates.length === 0) {
    return (
      <Alert tone="info" title="Still looking">
        We are finding people who can help. This page updates on its own.
      </Alert>
    );
  }

  // ── Choosing ──────────────────────────────────────────────────────────────

  return (
    <section className="space-y-4" aria-label="Choose an expert">
      <div>
        <h2 className="font-display text-xl font-medium text-ink">
          {view.candidates.length === 1
            ? "One expert is available"
            : `${String(view.candidates.length)} experts are available`}
        </h2>
        <p className="mt-1 text-sm text-ink-muted">
          Each of them has the depth your problem needs and said they can take it now. Pick whoever
          you prefer.
        </p>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      <ul className="stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {view.candidates.map((candidate) => (
          <li key={candidate.attemptId}>
            <Card interactive className="flex h-full flex-col">
              <CardBody className="flex flex-1 flex-col gap-3 p-5">
                <div className="flex items-center gap-3">
                  <ExpertAvatar photoUrl={candidate.photoUrl} name={candidate.displayName} />
                  <div className="min-w-0">
                    <p className="truncate font-display text-base font-medium text-ink">
                      {candidate.displayName}
                    </p>
                    {candidate.yearsExperience !== null && (
                      <p className="text-xs text-ink-subtle">
                        {candidate.yearsExperience} years with Salesforce
                      </p>
                    )}
                  </div>
                </div>

                {candidate.headline && (
                  <p className="line-clamp-4 flex-1 text-sm leading-relaxed text-ink-muted">
                    {candidate.headline}
                  </p>
                )}

                {candidate.matchedSkills.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {candidate.matchedSkills.slice(0, 3).map((skill) => (
                      <Badge
                        key={skill.name}
                        tone={skill.verified ? "available" : "neutral"}
                        title={skill.verified ? "Verified by our team" : undefined}
                      >
                        {skill.name}
                      </Badge>
                    ))}
                  </div>
                )}

                <dl className="flex gap-5 border-t border-border pt-3 text-xs">
                  <div>
                    <dt className="tracking-wide text-ink-subtle uppercase">Rating</dt>
                    <dd data-numeric className="mt-0.5 text-sm text-ink">
                      {candidate.rating
                        ? `${String(candidate.rating.average)} (${String(candidate.rating.count)})`
                        : "New here"}
                    </dd>
                  </div>
                  <div>
                    <dt className="tracking-wide text-ink-subtle uppercase">Delivered</dt>
                    <dd data-numeric className="mt-0.5 text-sm text-ink">
                      {candidate.sessionsCompleted > 0
                        ? `${String(candidate.hoursDelivered)}h · ${String(candidate.sessionsCompleted)}`
                        : "First session"}
                    </dd>
                  </div>
                </dl>

                <Button
                  size="md"
                  className="mt-1 w-full"
                  disabled={busy !== null}
                  onClick={() => void choose(candidate.attemptId)}
                >
                  {busy === candidate.attemptId ? "Asking them…" : "Choose"}
                </Button>
              </CardBody>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}
