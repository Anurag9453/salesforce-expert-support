"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, Card, CardBody } from "@/components/ui";
import { formatMoney } from "@/lib/format";
import { reportTiming, useRealtime } from "@/lib/use-realtime";

/**
 * Requests this expert has been asked to consider.
 *
 * The deliberate difference from the offer panel is that **there is no
 * countdown**. Raising a hand is not a commitment and does not lock the
 * expert's availability, so putting a clock on it would manufacture urgency
 * that the mechanic does not actually carry. The customer's shortlist closes
 * when it closes; hurrying the expert buys nothing.
 *
 * Several can be open at once — an expert may be interested in three requests
 * simultaneously, and only becomes committed if a customer picks them and they
 * then confirm.
 *
 * Reconciles the same way every other live surface does: a realtime signal
 * triggers a re-fetch, never an in-place edit from a payload.
 */

interface Opportunity {
  attemptId: string;
  supportRequestId: string;
  title: string;
  description: string;
  difficulty: string | null;
  skills: Array<{ slug: string; name: string; isPrimary: boolean }>;
  durationMinutes: number;
  payoutCents: number;
  currency: string;
}

export function InterestPanel() {
  const [items, setItems] = useState<Opportunity[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reconcile = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/expert/interest");
      const body = await response.json();
      if (body.ok) setItems(body.data.items as Opportunity[]);
    } catch {
      // The stream or the fallback poll will try again.
    } finally {
      setLoaded(true);
    }
  }, []);

  useRealtime(reconcile);
  useEffect(() => {
    void reconcile();
  }, [reconcile]);

  async function answer(attemptId: string, interested: boolean) {
    setBusy(attemptId);
    setError(null);
    try {
      const response = await fetch(`/api/v1/expert/interest?attemptId=${attemptId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ interested }),
      });
      const body = await response.json();
      if (!body.ok) {
        setError(body.error.message);
        return;
      }
      if (interested) {
        reportTiming("expert_reconciled", { supportRequestId: attemptId });
      }
      // Drop it locally, then reconcile — the row is gone from the query either
      // way, and this avoids the card lingering for a beat after the click.
      setItems((current) => current.filter((item) => item.attemptId !== attemptId));
      void reconcile();
    } catch {
      setError("Could not reach the server. Check your connection.");
    } finally {
      setBusy(null);
    }
  }

  if (!loaded || items.length === 0) return null;

  return (
    <section className="space-y-3" aria-label="Requests you can express interest in">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="accent" pulse>
          {items.length} looking for someone
        </Badge>
        <span className="text-xs text-ink-subtle">
          Saying you are interested does not commit you — the customer still chooses.
        </span>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      <ul className="stagger space-y-3">
        {items.map((item) => {
          const primary = item.skills.filter((skill) => skill.isPrimary);
          const secondary = item.skills.filter((skill) => !skill.isPrimary);
          return (
            <li key={item.attemptId}>
              <Card accent>
                <CardBody className="space-y-3 p-5">
                  <h3 className="font-display text-lg leading-snug font-medium text-balance text-ink">
                    {item.title}
                  </h3>
                  <p className="line-clamp-4 text-sm leading-relaxed whitespace-pre-wrap text-ink-muted">
                    {item.description}
                  </p>

                  <div className="flex flex-wrap items-center gap-1.5">
                    {primary.map((skill) => (
                      <Badge key={skill.slug} tone="accent" title="The core skill this needs">
                        {skill.name}
                      </Badge>
                    ))}
                    {secondary.map((skill) => (
                      <Badge key={skill.slug}>{skill.name}</Badge>
                    ))}
                    {item.difficulty && <Badge>{item.difficulty.toLowerCase()}</Badge>}
                  </div>

                  <dl className="flex flex-wrap gap-6 border-t border-border pt-3">
                    <div>
                      <dt className="eyebrow text-ink-subtle">Session</dt>
                      <dd data-numeric className="font-display text-lg font-medium text-ink">
                        {item.durationMinutes} min
                      </dd>
                    </div>
                    <div>
                      <dt className="eyebrow text-ink-subtle">You earn</dt>
                      <dd data-numeric className="font-display text-lg font-medium text-available">
                        {formatMoney(item.payoutCents, item.currency)}
                      </dd>
                    </div>
                  </dl>

                  <div className="flex flex-wrap gap-2.5 pt-1">
                    <Button
                      size="md"
                      loading={busy === item.attemptId}
                      disabled={busy === item.attemptId}
                      onClick={() => void answer(item.attemptId, true)}
                    >
                      {busy === item.attemptId ? "Sending…" : "Interested"}
                    </Button>
                    <Button
                      size="md"
                      variant="secondary"
                      loading={busy === item.attemptId}
                      disabled={busy === item.attemptId}
                      onClick={() => void answer(item.attemptId, false)}
                    >
                      Not interested
                    </Button>
                  </div>
                </CardBody>
              </Card>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
