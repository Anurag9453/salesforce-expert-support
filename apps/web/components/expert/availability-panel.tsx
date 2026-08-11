"use client";

import type { AvailabilityView } from "@sfx/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Badge, Button } from "@/components/ui";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The availability toggle, the presence heartbeat, and the eligibility banner
 * (requirements 5, 6 and 9).
 *
 * Requirement 6 is a design constraint, not a copy tweak. An expert's income
 * depends on whether they are in the dispatch pool, so "am I on right now?" must
 * be answerable from across the room — hence a full-width banner with a colour,
 * a headline in plain language, and, when they are not eligible, the specific
 * reasons. The word "AVAILABLE" alone would not do it: an expert can be
 * AVAILABLE and still not matchable, which is exactly the confusion requirement
 * 4 exists to prevent.
 *
 * Every value here comes from the server. The component holds no eligibility
 * logic of its own — it renders the verdict it was given (requirement 9, so the
 * mobile client cannot drift from this one).
 */

type Tone = "live" | "off" | "busy";

const PRESENTATION: Record<
  AvailabilityView["availabilityStatus"],
  { tone: Tone; badge: string; heading: string }
> = {
  AVAILABLE: { tone: "live", badge: "Online", heading: "You are receiving requests" },
  OFFLINE: { tone: "off", badge: "Offline", heading: "You are not receiving requests" },
  ON_OFFER: { tone: "busy", badge: "Request waiting", heading: "A request is waiting for you" },
  IN_SESSION: { tone: "busy", badge: "In session", heading: "You are in a session" },
};

const TONE_CLASSES: Record<Tone, string> = {
  live: "border-available/40 bg-available-subtle shadow-raised",
  off: "border-border-strong bg-surface-sunken",
  busy: "border-accent/40 bg-accent-subtle shadow-raised",
};

export function AvailabilityPanel({
  initial,
  canGoAvailable,
}: {
  initial: AvailabilityView;
  /**
   * Server-computed from the *application status*, not from a role. When false
   * the toggle is not rendered at all — and the API would refuse it anyway
   * (requirement 3).
   */
  canGoAvailable: boolean;
}) {
  const [view, setView] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tracks whether the last sweep was surfaced, so the explanation appears once
  // when it happens rather than every render.
  const wasAvailable = useRef(initial.availabilityStatus === "AVAILABLE");
  const [sweptNotice, setSweptNotice] = useState(false);

  const apply = useCallback((next: AvailabilityView) => {
    if (wasAvailable.current && next.availabilityStatus === "OFFLINE") {
      // We were online and are now offline without the expert touching the
      // toggle — the sweep took us. Say so plainly; a status that changes with
      // no explanation reads as a bug.
      setSweptNotice(true);
    }
    if (next.availabilityStatus === "AVAILABLE") setSweptNotice(false);
    wasAvailable.current = next.availabilityStatus === "AVAILABLE";
    setView(next);
  }, []);

  // ── Presence ────────────────────────────────────────────────────────────
  //
  // Only while the server says we are online. Pinging while offline would be
  // pure noise: the ping cannot bring us back (requirement 5), so there is
  // nothing for it to accomplish.
  const shouldBeat = view.availabilityStatus !== "OFFLINE";
  const intervalMs = view.heartbeatIntervalSeconds * 1000;

  const beat = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/expert/heartbeat", { method: "POST" });
      const body = await response.json();
      // The response carries the current view, so a heartbeat is also how a tab
      // finds out it was swept — no separate poll needed.
      if (body.ok) apply(body.data);
    } catch {
      // A dropped ping is not worth an error banner. The next one is 45 seconds
      // away, and if the network is really gone the sweep is the correct
      // outcome anyway.
    }
  }, [apply]);

  useEffect(() => {
    if (!shouldBeat) return;
    const timer = setInterval(() => void beat(), intervalMs);
    return () => clearInterval(timer);
  }, [shouldBeat, intervalMs, beat]);

  useEffect(() => {
    if (!shouldBeat) return;
    // Background tabs get their timers throttled to roughly once a minute, so
    // coming back to the tab is the moment most likely to be just after a sweep.
    // Ping immediately rather than waiting out the remaining interval.
    const onVisible = () => {
      if (document.visibilityState === "visible") void beat();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [shouldBeat, beat]);

  // ── Toggle ──────────────────────────────────────────────────────────────

  async function toggle(available: boolean) {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/expert/availability", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ available }),
      });
      const body = await response.json();
      if (body.ok) {
        if (available) setSweptNotice(false);
        apply(body.data);
      } else {
        setError(body.error?.message ?? "Could not change your availability.");
      }
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  const presentation = PRESENTATION[view.availabilityStatus];
  const { eligible, messages } = view.eligibility;
  const online = view.availabilityStatus === "AVAILABLE";
  const locked = view.availabilityStatus === "ON_OFFER" || view.availabilityStatus === "IN_SESSION";

  return (
    <section className="space-y-3" aria-label="Availability">
      <div
        className={cn(
          "animate-rise-in rounded-xl border p-5 transition-colors duration-500",
          TONE_CLASSES[presentation.tone],
        )}
        // Announced to screen readers when the sweep changes it out from under
        // the expert — the same information the colour carries.
        role="status"
        aria-live="polite"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            {/*
              The pulsing dot now comes from Badge rather than a second local
              copy — one implementation of "this state is live".
            */}
            <Badge
              tone={online ? "available" : presentation.tone === "busy" ? "accent" : "neutral"}
              dot={!online}
              pulse={online}
            >
              {presentation.badge}
            </Badge>
            <h2 className="font-display mt-2.5 text-xl leading-snug font-medium text-balance text-ink">
              {presentation.heading}
            </h2>

            {/*
              Requirement 4 made visible. "Online" and "eligible" are different
              questions, and when they disagree the expert is told which
              conditions are unmet rather than left to guess.
            */}
            {eligible ? (
              <p className="mt-1 text-sm text-ink-muted">
                Everything is in order — you are in the pool for matching requests.
              </p>
            ) : (
              <ul className="mt-2 space-y-1">
                {messages.map((message) => (
                  <li key={message} className="flex gap-2 text-sm text-ink-muted">
                    <span aria-hidden="true">•</span>
                    <span>{message}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {canGoAvailable && !locked ? (
            <Button
              variant={online ? "secondary" : "primary"}
              size="lg"
              disabled={pending}
              onClick={() => void toggle(!online)}
            >
              {pending ? "Saving…" : online ? "Go offline" : "Go available"}
            </Button>
          ) : null}
        </div>

        {online ? (
          <p className="mt-4 border-t border-border pt-3 text-xs text-ink-subtle">
            Keep this page open. We check in every {view.heartbeatIntervalSeconds} seconds; if we
            have not heard from you for {formatDuration(view.heartbeatStaleAfterSeconds)} we take
            you offline so customers are not left waiting on someone who has stepped away.
            {view.secondsSinceHeartbeat !== null && (
              <> Last check-in {view.secondsSinceHeartbeat}s ago.</>
            )}
          </p>
        ) : null}
      </div>

      {sweptNotice ? (
        <Alert tone="warning" title="We took you offline">
          We stopped hearing from this page, so you were removed from the pool. You will stay
          offline until you turn availability back on — we never do that for you.
        </Alert>
      ) : null}

      {!canGoAvailable ? (
        <Alert tone="info" title="Availability opens when your application is approved">
          Only approved experts can join the matching pool.
        </Alert>
      ) : null}

      {error ? (
        <Alert tone="danger" title="Could not change your availability">
          {error}
        </Alert>
      ) : null}
    </section>
  );
}
