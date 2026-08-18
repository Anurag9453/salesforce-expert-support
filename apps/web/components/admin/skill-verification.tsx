"use client";

import type { ExpertSkillView, ProficiencyGuidance, ProficiencyLevel } from "@sfx/contracts";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, Badge, Button, Field, Textarea } from "@/components/ui";

/**
 * The only place `verified` can be set (requirement 2).
 *
 * A verification is the platform vouching for a claim to customers who never get
 * to choose their own expert, so notes are mandatory and the button stays
 * disabled without them. That is courtesy — the domain rejects a reasonless
 * verification whatever this component sends — but it makes the expectation
 * visible at the moment of the decision.
 */
export function SkillVerification({
  expertProfileId,
  initial,
  guidance,
}: {
  expertProfileId: string;
  initial: readonly ExpertSkillView[];
  guidance: Record<ProficiencyLevel, ProficiencyGuidance>;
}) {
  const router = useRouter();
  const [skills, setSkills] = useState<readonly ExpertSkillView[]>(initial);
  const [active, setActive] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(skillSlug: string, verified: boolean) {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/admin/experts/${expertProfileId}/skills`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ skillSlug, verified, notes }),
      });
      const body = await response.json();
      if (body.ok) {
        const saved = body.data as ExpertSkillView;
        setSkills((current) =>
          current.map((skill) => (skill.skillSlug === saved.skillSlug ? saved : skill)),
        );
        setActive(null);
        setNotes("");
        router.refresh();
      } else {
        setError(body.error?.message ?? "Could not record that.");
      }
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setPending(false);
    }
  }

  if (skills.length === 0) {
    return (
      <p className="text-sm text-ink-muted">
        This expert has not listed any skills. They cannot be matched to anything until they do.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {error ? (
        <Alert tone="danger" title="Could not save">
          {error}
        </Alert>
      ) : null}

      <ul className="divide-y divide-border">
        {skills.map((skill) => (
          <li key={skill.skillSlug} className="py-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm font-medium text-ink">
                  {skill.name}
                  {skill.verified ? (
                    <Badge tone="available">Verified</Badge>
                  ) : (
                    <Badge tone="neutral">Self-declared</Badge>
                  )}
                </p>
                <p className="text-xs text-ink-subtle">
                  {guidance[skill.proficiencyLevel].label} · {skill.yearsExperience}{" "}
                  {skill.yearsExperience === 1 ? "year" : "years"} · {skill.categorySlug}
                </p>
              </div>
              <Button
                variant={skill.verified ? "ghost" : "secondary"}
                size="sm"
                className="ml-auto"
                loading={pending}
                disabled={pending}
                onClick={() => {
                  setActive(active === skill.skillSlug ? null : skill.skillSlug);
                  setNotes("");
                }}
              >
                {skill.verified ? "Remove verification" : "Verify"}
              </Button>
            </div>

            {active === skill.skillSlug ? (
              <div className="mt-3 space-y-3 rounded-md border border-border bg-surface-sunken p-3">
                <Field
                  id={`notes-${skill.skillSlug}`}
                  label={
                    skill.verified
                      ? "Why is this verification being removed?"
                      : "What is this verification based on?"
                  }
                  hint="Recorded in the audit log against you. Not shown to the expert."
                  required
                >
                  <Textarea
                    id={`notes-${skill.skillSlug}`}
                    rows={3}
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                  />
                </Field>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant={skill.verified ? "danger" : "primary"}
                    loading={pending}
                    disabled={pending || notes.trim().length === 0}
                    onClick={() => void submit(skill.skillSlug, !skill.verified)}
                  >
                    {pending ? "Saving…" : skill.verified ? "Remove verification" : "Verify skill"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => setActive(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
