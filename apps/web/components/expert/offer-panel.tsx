"use client";

import { DECLINE_REASON_LABELS, type DeclineReasonCode, type OfferView } from "@sfx/contracts";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, Card, CardBody, Field, Textarea } from "@/components/ui";
import { playOfferSound, showOfferNotification } from "@/lib/offer-alerts";
import { reportTiming, useRealtime } from "@/lib/use-realtime";
import { cn } from "@/lib/utils";

/**
 * The incoming offer.
 *
 * This is the screen the whole product turns on: an expert has 60 seconds to
 * decide, and the decision has to be easy to make well. Three things follow from
 * that:
 *
 *   - **The countdown is honest.** It ticks toward the server's stored
 *     `offerExpiresAt`, not down from 60. Reloading the page does not restart it,
 *     because there is nothing client-side to restart (requirement 8).
 *   - **Accept is one click.** Decline is one click too; the reason picker
 *     appears *after*, and skipping it is a first-class action rather than a
 *     dismiss (requirement 9).
 *   - **A manual assignment says so.** An expert chosen by a human is told a
 *     human chose them, and why (requirement 13).
 *
 * ## Realtime (Phase 6)
 *
 * The offer arrives over SSE and this component's response to a signal is always
 * the same: **re-fetch** (requirement 3). It never reads an event payload, so
 * duplicate or replayed signals cause duplicate fetches and one outcome
 * (requirement 2), and a signal cannot restart the countdown because the deadline
 * comes from the fetched offer (requirement 15).
 *
 * Reconnecting reconciles rather than resumes (requirement 14): an expert who was
 * disconnected while their offer expired comes back to "that one has gone", not to
 * a card they can still click.
 */

export function OfferPanel({ initial }: { initial: OfferView | null }) {
  const router = useRouter();
  const [offer, setOffer] = useState<OfferView | null>(initial);
  const [remaining, setRemaining] = useState(initial?.secondsRemaining ?? 0);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState<DeclineReasonCode | null>(null);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<"accepted" | "declined" | "expired" | null>(null);

  // The deadline as an absolute instant, so the tick below is a subtraction
  // rather than a decrement — a backgrounded tab that misses ticks still shows
  // the right number when it comes back.
  const expiresAtMs = useRef<number | null>(initial ? Date.parse(initial.offerExpiresAt) : null);
  // Which offer we have already alerted on, so reconciling twice does not make
  // the sound play twice (requirement 2, from the user's side).
  const alertedFor = useRef<string | null>(initial?.attemptId ?? null);
  const offerRef = useRef<OfferView | null>(initial);
  offerRef.current = offer;
  const outcomeRef = useRef(outcome);
  outcomeRef.current = outcome;

  /**
   * The single reconcile path.
   *
   * Called on a signal, on connect, on reconnect, and on the slow fallback poll.
   * All four do the same thing, which is why none of them can disagree.
   */
  const reconcile = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/expert/offer");
      const body = await response.json();
      if (!body.ok) return;
      const next = body.data as OfferView | null;
      const current = offerRef.current;

      if (next) {
        setOffer(next);
        expiresAtMs.current = Date.parse(next.offerExpiresAt);
        setRemaining(next.secondsRemaining);
        setOutcome(null);

        // First time we have seen this particular offer: alert, and report how
        // long it took to become visible (requirement 16, point 6).
        if (alertedFor.current !== next.attemptId) {
          alertedFor.current = next.attemptId;
          playOfferSound();
          showOfferNotification(next.skills.map((skill) => skill.name));
          reportTiming("expert_reconciled", {
            supportRequestId: next.supportRequestId,
            observedLatencyMs: Math.max(0, Date.now() - Date.parse(next.offeredAt)),
          });
        }
      } else if (current && !outcomeRef.current) {
        // It vanished without us answering: it expired, or an admin reassigned
        // it. Requirement 14 — say so plainly rather than leaving a dead card, and
        // never resurrect it.
        setOutcome("expired");
        setOffer(null);
        expiresAtMs.current = null;
      }
    } catch {
      // A dropped fetch is not worth an error banner. The stream or the fallback
      // poll will try again.
    }
  }, []);

  const realtimeStatus = useRealtime(reconcile);

  useEffect(() => {
    if (!offer) return;
    const tick = () => {
      const deadline = expiresAtMs.current;
      if (deadline === null) return;
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0) {
        setOutcome("expired");
        setOffer(null);
        router.refresh();
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [offer, router]);

  async function respond(body: Record<string, unknown>) {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/expert/offer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (result.ok) {
        setOutcome(body.decision === "accept" ? "accepted" : "declined");
        setOffer(null);
        expiresAtMs.current = null;
        setDeclining(false);
        router.refresh();
      } else {
        setError(result.error?.message ?? "Could not send your answer.");
        // Almost always "it expired" or "someone else got it" — reconcile so the
        // screen tells the truth rather than showing a stale card.
        void reconcile();
      }
    } catch {
      setError("Could not reach the server. Check your connection.");
    } finally {
      setPending(false);
    }
  }

  // ── Outcomes ─────────────────────────────────────────────────────────────

  if (outcome === "accepted") {
    return (
      <Alert tone="success" title="You took it">
        The customer has been told. Session setup lands in Phase 8 — for now this is where the Phase
        5 loop ends.
      </Alert>
    );
  }
  if (outcome === "declined") {
    return (
      <Alert tone="info" title="Declined">
        We are offering it to someone else. You are back in the pool.
      </Alert>
    );
  }
  if (outcome === "expired") {
    return (
      <Alert tone="warning" title="That one has gone">
        The 60 seconds ran out, so it went to the next expert. Declining is always better than
        letting it lapse — it moves the customer along faster and it does not count against you the
        same way.
      </Alert>
    );
  }

  if (!offer) {
    return (
      <Card>
        <CardBody className="py-8 text-center">
          <p className="text-sm text-ink-muted">
            No requests right now. Keep this page open — an offer will appear here the moment one is
            matched to you.
          </p>
          {/* Honest about the transport, because "is this thing working?" is the
              question an expert waiting for work actually has. */}
          <p className="mt-2 text-xs text-ink-subtle">
            {realtimeStatus === "live"
              ? "Connected — offers arrive instantly."
              : realtimeStatus === "connecting"
                ? "Connecting…"
                : "Reconnecting — offers will still appear, just a few seconds later."}
          </p>
        </CardBody>
      </Card>
    );
  }

  // ── The offer ────────────────────────────────────────────────────────────

  const urgent = remaining <= 15;
  const primary = offer.skills.filter((skill) => skill.isPrimary);
  const secondary = offer.skills.filter((skill) => !skill.isPrimary);

  return (
    <section
      className={cn(
        "rounded-lg border-2 p-5",
        urgent ? "border-danger bg-danger-subtle" : "border-accent bg-accent-subtle",
      )}
      aria-live="assertive"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="size-2.5 animate-pulse rounded-full bg-accent" aria-hidden="true" />
            <Badge tone="accent">New request</Badge>
            {offer.origin !== "ALGORITHMIC" && (
              <Badge tone="warning">
                {offer.origin === "ADMIN_FORCE_ASSIGN" ? "Sent by our team" : "Chosen for you"}
              </Badge>
            )}
          </div>
          <h2 className="mt-2 text-lg font-semibold tracking-tight text-ink">{offer.title}</h2>
        </div>
        <div className="text-right">
          <p
            className={cn(
              "font-mono text-3xl font-semibold tabular-nums",
              urgent ? "text-danger" : "text-ink",
            )}
          >
            {remaining}s
          </p>
          <p className="text-xs text-ink-subtle">to answer</p>
        </div>
      </div>

      {/*
        Requirement 13 from the expert's side. Being told "our team picked you and
        here is why" is a different experience from an offer that just appeared,
        and the difference matters most in the cases where an operator intervened.
      */}
      {offer.adminNote && (
        <Alert tone="info" title="A note from our team" className="mt-4">
          {offer.adminNote}
        </Alert>
      )}

      <div className="mt-4 space-y-3 rounded-md border border-border bg-surface-raised p-4">
        <p className="whitespace-pre-wrap text-sm text-ink">{offer.description}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          {primary.map((skill) => (
            <Badge key={skill.slug} tone="accent" title="The core skill this needs">
              {skill.name}
            </Badge>
          ))}
          {secondary.map((skill) => (
            <Badge key={skill.slug}>{skill.name}</Badge>
          ))}
          {offer.difficulty && <Badge tone="neutral">{offer.difficulty.toLowerCase()}</Badge>}
        </div>
        <dl className="flex gap-6 border-t border-border pt-3 text-sm">
          <div>
            <dt className="text-xs text-ink-subtle">Session</dt>
            <dd className="text-ink">{offer.durationMinutes} minutes</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-subtle">You earn</dt>
            <dd className="text-ink">₹{(offer.payoutCents / 100).toLocaleString("en-IN")}</dd>
          </div>
        </dl>
      </div>

      {error && (
        <Alert tone="danger" className="mt-4">
          {error}
        </Alert>
      )}

      {declining ? (
        <div className="mt-4 space-y-3 rounded-md border border-border bg-surface-raised p-4">
          {/*
            Requirement 9. The reason is genuinely optional: "Decline without a
            reason" is a real button, not a cancel link. An expert who must
            justify saying no starts saying yes to work they should not take.
          */}
          <p className="text-sm font-medium text-ink">Anything you want to tell us? Optional.</p>
          <div className="grid gap-1.5">
            {(Object.keys(DECLINE_REASON_LABELS) as DeclineReasonCode[]).map((code) => (
              <label
                key={code}
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 rounded-md border p-2.5 text-sm",
                  reason === code ? "border-accent bg-accent-subtle" : "border-border",
                )}
              >
                <input
                  type="radio"
                  name="decline-reason"
                  checked={reason === code}
                  onChange={() => setReason(code)}
                  disabled={pending}
                />
                <span className="text-ink">{DECLINE_REASON_LABELS[code]}</span>
              </label>
            ))}
          </div>
          {reason === "OTHER" && (
            <Field id="decline-note" label="In a few words" hint="Optional.">
              <Textarea
                id="decline-note"
                rows={2}
                value={note}
                maxLength={500}
                onChange={(event) => setNote(event.target.value)}
              />
            </Field>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="danger"
              disabled={pending}
              onClick={() =>
                void respond({
                  decision: "decline",
                  ...(reason ? { reason } : {}),
                  ...(reason === "OTHER" && note.trim() ? { note: note.trim() } : {}),
                })
              }
            >
              {pending ? "Sending…" : reason ? "Decline" : "Decline without a reason"}
            </Button>
            <Button variant="ghost" disabled={pending} onClick={() => setDeclining(false)}>
              Back
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="lg" disabled={pending} onClick={() => void respond({ decision: "accept" })}>
            {pending ? "Taking it…" : "Accept"}
          </Button>
          <Button
            size="lg"
            variant="secondary"
            disabled={pending}
            onClick={() => setDeclining(true)}
          >
            Decline
          </Button>
        </div>
      )}
    </section>
  );
}
