"use client";

import type { AdminExpertDecision, ExpertApplication } from "@sfx/contracts";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Field, Textarea } from "@/components/ui";

/**
 * Admin decision controls.
 *
 * Every consequential action requires a reason before the button enables — but
 * that is courtesy, not enforcement. The domain rejects a reasonless decision
 * regardless of what the client sends (requirement 3).
 */
type Action = Exclude<AdminExpertDecision["decision"], "claim">;

const ACTIONS: Record<
  Action,
  { label: string; variant: "primary" | "secondary" | "danger"; prompt: string }
> = {
  approve: {
    label: "Approve",
    variant: "primary",
    prompt: "Why is this expert being approved?",
  },
  reject: {
    label: "Reject",
    variant: "danger",
    prompt: "Why is this application being rejected? The applicant will see this.",
  },
  suspend: {
    label: "Suspend",
    variant: "danger",
    prompt: "Why is this expert being suspended?",
  },
  reinstate: {
    label: "Reinstate",
    variant: "primary",
    prompt: "Why is this expert being reinstated?",
  },
};

function availableActions(status: ExpertApplication["status"]): Action[] {
  switch (status) {
    case "SUBMITTED":
    case "UNDER_REVIEW":
      return ["approve", "reject"];
    case "APPROVED":
      return ["suspend"];
    case "SUSPENDED":
      return ["reinstate"];
    default:
      return [];
  }
}

export function DecisionPanel({ application }: { application: ExpertApplication }) {
  const router = useRouter();
  const [active, setActive] = useState<Action | null>(null);
  const [notes, setNotes] = useState("");
  const [verified, setVerified] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const actions = availableActions(application.status);
  const canClaim = application.status === "SUBMITTED";

  async function send(body: AdminExpertDecision) {
    setPending(true);
    setError(null);
    const response = await fetch(`/api/v1/admin/experts/${application.id}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!result.ok) {
      setError(result.error.message);
      setPending(false);
      return;
    }
    setActive(null);
    setNotes("");
    setPending(false);
    router.refresh();
  }

  if (actions.length === 0 && !canClaim) {
    return <p className="text-sm text-ink-subtle">No actions available at this status.</p>;
  }

  return (
    <div className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}

      {active === null ? (
        <div className="flex flex-wrap gap-2">
          {canClaim && (
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() => void send({ decision: "claim" })}
            >
              Claim for review
            </Button>
          )}
          {actions.map((action) => (
            <Button
              key={action}
              variant={ACTIONS[action].variant}
              disabled={pending}
              onClick={() => setActive(action)}
            >
              {ACTIONS[action].label}
            </Button>
          ))}
        </div>
      ) : (
        <div className="space-y-3 rounded-md border border-border bg-surface-sunken p-4">
          {/*
            Approval asks what was actually checked, before it asks why.

            Empty is a legitimate answer — plenty of capable Salesforce people
            hold no certifications, and demanding one would push reviewers into
            inventing them. What this refuses to allow is approving *without
            having looked*, which is the habit that lets an unvetted person
            through. It is stored apart from the applicant's own claims.
          */}
          {active === "approve" && (
            <Field
              id="verifiedCertifications"
              label="What did you verify on their Trailhead profile?"
              hint="Comma separated. Leave empty if they hold none — but open the profile first."
            >
              <Textarea
                id="verifiedCertifications"
                rows={2}
                value={verified}
                onChange={(event) => setVerified(event.target.value)}
                placeholder="Certified Administrator, Platform Developer I"
              />
            </Field>
          )}

          <Field id="notes" label={ACTIONS[active].prompt} required>
            <Textarea
              id="notes"
              rows={3}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Recorded against this decision, with your name and the time."
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              variant={ACTIONS[active].variant}
              disabled={pending || notes.trim().length === 0}
              onClick={() =>
                void send({
                  decision: active,
                  notes,
                  ...(active === "approve"
                    ? {
                        verifiedCertifications: verified
                          .split(",")
                          .map((value) => value.trim())
                          .filter(Boolean),
                      }
                    : {}),
                } as AdminExpertDecision)
              }
            >
              {pending ? "Recording…" : `Confirm ${ACTIONS[active].label.toLowerCase()}`}
            </Button>
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setActive(null);
                setNotes("");
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
