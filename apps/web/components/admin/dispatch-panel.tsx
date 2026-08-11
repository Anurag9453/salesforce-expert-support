"use client";

import type { DispatchCandidateView } from "@sfx/contracts";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Badge, Button, Field, Textarea } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * Manual dispatch (requirement 12).
 *
 * Two operations that look similar and mean very different things, so the UI
 * keeps them visibly apart rather than offering one button with a checkbox:
 *
 *   - **Assign** — you are choosing *who*, from the candidates the algorithm
 *     already qualified. Ordinary operational work.
 *   - **Force Assign** — you are overriding the competence rules themselves.
 *     Only reachable for a candidate the algorithm excluded, styled as a
 *     destructive action, and it names what it is overriding.
 *
 * Neither can bypass the expert's acceptance, and the panel says so where an
 * operator will read it — before they click, not after.
 */

const REASON_LABELS: Record<string, string> = {
  NOT_APPROVED: "not an approved expert",
  ACCOUNT_NOT_ACTIVE: "account not active",
  NOT_AVAILABLE: "offline",
  PRESENCE_STALE: "presence stale",
  ALREADY_ON_OFFER: "already holds an offer",
  IN_SESSION: "in a session",
  MISSING_PRIMARY_SKILL: "has not declared the primary skill",
  PRIMARY_BELOW_FLOOR: "primary skill below the floor",
  INSUFFICIENT_SECONDARY_COVERAGE: "too few secondary skills",
  RATING_BELOW_FLOOR: "rating below the floor",
  NO_LANGUAGE_OVERLAP: "no language in common",
  ALREADY_RESPONDED: "already declined or timed out",
  IS_THE_CUSTOMER: "is the customer",
};

export function DispatchPanel({
  supportRequestId,
  candidates,
  active,
}: {
  supportRequestId: string;
  candidates: readonly DispatchCandidateView[];
  /** False once the request has been accepted or has ended. */
  active: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<"assign" | "force">("assign");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  async function dispatch() {
    if (!selected) return;
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/v1/admin/requests/${supportRequestId}/dispatch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode, expertProfileId: selected, reason }),
      });
      const body = await response.json();
      if (body.ok) {
        setMessage({
          tone: "success",
          text: "Offered. They have 60 seconds to accept — a manual assignment still needs their yes.",
        });
        setSelected(null);
        setReason("");
        router.refresh();
      } else {
        setMessage({ tone: "danger", text: body.error?.message ?? "Could not dispatch." });
      }
    } catch {
      setMessage({ tone: "danger", text: "Could not reach the server." });
    } finally {
      setPending(false);
    }
  }

  if (!active) {
    return (
      <p className="text-sm text-ink-muted">
        This request is no longer being matched, so manual dispatch does not apply.
      </p>
    );
  }

  if (candidates.length === 0) {
    return (
      <p className="text-sm text-ink-muted">
        No matching run yet — nothing has been considered, so there is nobody to choose from.
      </p>
    );
  }

  const chosen = candidates.find((candidate) => candidate.expertProfileId === selected);
  const forcing = chosen !== undefined && !chosen.assignable;

  return (
    <div className="space-y-4">
      {message && <Alert tone={message.tone}>{message.text}</Alert>}

      <ul className="divide-y divide-border">
        {candidates.map((candidate) => {
          const isSelected = candidate.expertProfileId === selected;
          return (
            <li key={candidate.expertProfileId}>
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  setSelected(isSelected ? null : candidate.expertProfileId);
                  setMode(candidate.assignable ? "assign" : "force");
                }}
                className={cn(
                  "flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-2 py-3 text-left transition-colors",
                  isSelected ? "bg-accent-subtle" : "hover:bg-surface-sunken",
                )}
              >
                <span className="w-8 shrink-0 text-xs text-ink-subtle">
                  {candidate.rank !== null ? `#${candidate.rank}` : "—"}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink">{candidate.email}</span>
                  {candidate.exclusionReasons.length > 0 && (
                    // Requirement 4, at the point of decision: the operator sees
                    // exactly why the algorithm passed on them.
                    <span className="block text-xs text-ink-subtle">
                      {candidate.exclusionReasons
                        .map((code) => REASON_LABELS[code] ?? code)
                        .join(" · ")}
                    </span>
                  )}
                </span>
                <span className="font-mono text-xs text-ink-muted">
                  {candidate.finalScore !== null ? candidate.finalScore.toFixed(3) : "excluded"}
                </span>
                <Badge tone={candidate.assignable ? "available" : "neutral"}>
                  {candidate.availabilityStatus.toLowerCase()}
                </Badge>
              </button>
            </li>
          );
        })}
      </ul>

      {chosen && (
        <div className="animate-rise-in space-y-3 rounded-xl border border-border bg-surface-sunken p-4">
          {forcing ? (
            <Alert tone="warning" title="This is a Force Assign">
              The algorithm excluded {chosen.email} —{" "}
              {chosen.exclusionReasons.map((code) => REASON_LABELS[code] ?? code).join(", ")}. You
              are overriding that. They will still have to accept.
            </Alert>
          ) : (
            <p className="text-sm text-ink-muted">
              Assigning to {chosen.email}, who the algorithm already qualified. They will still have
              to accept.
            </p>
          )}

          <Field
            id="dispatch-reason"
            label="Why are you doing this manually?"
            hint="Recorded against you in the audit log, permanently. Required."
            required
          >
            <Textarea
              id="dispatch-reason"
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>

          <div className="flex flex-wrap gap-2">
            <Button
              variant={forcing ? "danger" : "primary"}
              disabled={pending || reason.trim().length === 0}
              onClick={() => void dispatch()}
            >
              {pending ? "Offering…" : forcing ? "Force assign" : "Assign"}
            </Button>
            <Button variant="ghost" disabled={pending} onClick={() => setSelected(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
