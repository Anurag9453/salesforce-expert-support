"use client";

import type {
  ExpertSkillView,
  ProficiencyGuidance,
  ProficiencyLevel,
  TaxonomyCategory,
} from "@sfx/contracts";
import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Field,
  Input,
} from "@/components/ui";

/**
 * Skill declaration (requirements 1, 2 and 7).
 *
 * Every claim is a triple: the skill, an honest self-rating, and years with
 * *that* skill. Years-in-Salesforce lives on the profile and is a different
 * number — eight years in Salesforce and six months of CPQ is a common, honest
 * shape, and flattening the two would hide it from matching.
 *
 * Requirement 7 shows up in three places here, none of which is a warning
 * message:
 *
 *  - Each proficiency level is described by observable behaviour ("you debug the
 *    difficult cases"), so picking one is a factual claim rather than a
 *    self-assessment of confidence.
 *  - The levels read low-to-high and none is preselected, so "Deep" is a
 *    deliberate reach rather than the default.
 *  - Verification is visible and unattainable by self-service, which makes the
 *    difference between a claim and a checked claim legible on the same screen.
 */

const LEVELS: readonly ProficiencyLevel[] = ["BEGINNER", "INTERMEDIATE", "ADVANCED", "EXPERT"];

interface Draft {
  skillSlug: string;
  proficiencyLevel: ProficiencyLevel | "";
  yearsExperience: string;
}

const EMPTY: Draft = { skillSlug: "", proficiencyLevel: "", yearsExperience: "" };

export function SkillsManager({
  initial,
  categories,
  guidance,
  maxSkills,
}: {
  initial: readonly ExpertSkillView[];
  categories: readonly TaxonomyCategory[];
  /** Written in the domain, served to every client so the wording cannot drift. */
  guidance: Record<ProficiencyLevel, ProficiencyGuidance>;
  maxSkills: number;
}) {
  const [skills, setSkills] = useState<readonly ExpertSkillView[]>(initial);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const declared = useMemo(() => new Set(skills.map((skill) => skill.skillSlug)), [skills]);
  const editing = draft.skillSlug !== "" && declared.has(draft.skillSlug);
  const atLimit = skills.length >= maxSkills && !editing;
  const editingVerified =
    editing && (skills.find((skill) => skill.skillSlug === draft.skillSlug)?.verified ?? false);

  async function save() {
    if (draft.proficiencyLevel === "") {
      setFieldErrors({ proficiencyLevel: ["Choose the level that matches what you actually do."] });
      return;
    }
    setPending(true);
    setError(null);
    setFieldErrors({});
    try {
      const response = await fetch("/api/v1/expert/skills", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          skillSlug: draft.skillSlug,
          proficiencyLevel: draft.proficiencyLevel,
          // Empty means zero, which is a real and acceptable answer.
          yearsExperience: Number(draft.yearsExperience || 0),
        }),
      });
      const body = await response.json();
      if (body.ok) {
        const saved = body.data as ExpertSkillView;
        setSkills((current) => {
          const rest = current.filter((skill) => skill.skillSlug !== saved.skillSlug);
          return [...rest, saved].sort((a, b) => a.name.localeCompare(b.name));
        });
        setDraft(EMPTY);
      } else {
        setError(body.error?.message ?? "Could not save that skill.");
        setFieldErrors(body.error?.fields ?? {});
      }
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setPending(false);
    }
  }

  async function remove(slug: string) {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/expert/skills/${encodeURIComponent(slug)}`, {
        method: "DELETE",
      });
      const body = await response.json();
      if (body.ok) {
        setSkills((current) => current.filter((skill) => skill.skillSlug !== slug));
      } else {
        setError(body.error?.message ?? "Could not remove that skill.");
      }
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setPending(false);
    }
  }

  function edit(skill: ExpertSkillView) {
    setDraft({
      skillSlug: skill.skillSlug,
      proficiencyLevel: skill.proficiencyLevel,
      yearsExperience: String(skill.yearsExperience),
    });
    setFieldErrors({});
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{editing ? "Update this skill" : "Add a skill"}</CardTitle>
        </CardHeader>
        <CardBody className="space-y-5">
          {/*
            Said before they save, not after. The verification is cleared because
            the claim it covered has changed — reasonable, but a surprise if the
            badge simply vanishes.
          */}
          {editingVerified ? (
            <Alert tone="warning" title="This will remove the verified badge">
              Our team verified your current rating for this skill. Changing it means that check no
              longer applies, so the skill goes back to self-declared until it is reviewed again.
            </Alert>
          ) : null}

          <Field
            id="skill"
            label="Skill"
            required
            hint="List what you would be comfortable being handed at short notice — not everything you have touched."
            error={fieldErrors.skillSlug}
          >
            <select
              id="skill"
              value={draft.skillSlug}
              disabled={pending}
              onChange={(event) =>
                setDraft((current) => ({ ...current, skillSlug: event.target.value }))
              }
              className="h-10 w-full rounded-md border border-border-strong bg-surface-raised px-3 text-sm text-ink"
            >
              <option value="">Choose a skill…</option>
              {categories.map((category) => (
                <optgroup key={category.slug} label={category.name}>
                  {category.skills.map((skill) => (
                    <option key={skill.slug} value={skill.slug}>
                      {skill.name}
                      {declared.has(skill.slug) ? " (already listed)" : ""}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>

          <fieldset className="space-y-1.5">
            <legend className="block text-sm font-medium text-ink">
              How deep is it?
              <span className="ml-1 text-danger" aria-hidden="true">
                *
              </span>
            </legend>
            <p className="text-xs text-ink-subtle">
              We match the hardest problems on the highest ratings, so an honest answer here means
              you get the requests you will actually enjoy — and few you will want to decline.
            </p>
            <div className="grid gap-2 pt-1">
              {LEVELS.map((level) => (
                <label
                  key={level}
                  className={`flex cursor-pointer gap-3 rounded-md border p-3 text-sm transition-colors ${
                    draft.proficiencyLevel === level
                      ? "border-accent bg-accent-subtle"
                      : "border-border hover:bg-surface-sunken"
                  }`}
                >
                  <input
                    type="radio"
                    name="proficiency"
                    value={level}
                    checked={draft.proficiencyLevel === level}
                    disabled={pending}
                    onChange={() =>
                      setDraft((current) => ({ ...current, proficiencyLevel: level }))
                    }
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium text-ink">{guidance[level].label}</span>
                    <span className="mt-0.5 block text-ink-muted">
                      {guidance[level].description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {fieldErrors.proficiencyLevel?.length ? (
              <p role="alert" className="text-xs text-danger">
                {fieldErrors.proficiencyLevel.join(" ")}
              </p>
            ) : null}
          </fieldset>

          <Field
            id="years"
            label="Years with this skill"
            required
            hint="Years working with this specific skill — not your total Salesforce experience. Zero is a fine answer."
            error={fieldErrors.yearsExperience}
          >
            <Input
              id="years"
              type="number"
              min={0}
              max={40}
              inputMode="numeric"
              value={draft.yearsExperience}
              disabled={pending}
              onChange={(event) =>
                setDraft((current) => ({ ...current, yearsExperience: event.target.value }))
              }
            />
          </Field>

          {atLimit ? (
            <Alert tone="warning" title={`You have reached the limit of ${maxSkills} skills`}>
              Remove one to add another. A focused list matches better than an exhaustive one.
            </Alert>
          ) : null}

          {error ? (
            <Alert tone="danger" title="Could not save">
              {error}
            </Alert>
          ) : null}

          <div className="flex gap-2">
            <Button disabled={pending || !draft.skillSlug || atLimit} onClick={() => void save()}>
              {pending ? "Saving…" : editing ? "Update skill" : "Add skill"}
            </Button>
            {draft.skillSlug ? (
              <Button variant="ghost" disabled={pending} onClick={() => setDraft(EMPTY)}>
                Cancel
              </Button>
            ) : null}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your skills ({skills.length})</CardTitle>
        </CardHeader>
        <CardBody>
          {skills.length === 0 ? (
            <p className="text-sm text-ink-muted">
              Nothing listed yet. We match on skills, so no request can reach you until you add at
              least one.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {skills.map((skill) => (
                <li
                  key={skill.skillSlug}
                  className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3"
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium text-ink">
                      {skill.name}
                      {/*
                        Requirement 2, made visible. Verification is a badge the
                        expert can see and cannot award themselves — there is no
                        control here that sets it, because there is no request
                        shape that could.
                      */}
                      {skill.verified ? (
                        <Badge tone="available" title="Checked by our review team">
                          Verified
                        </Badge>
                      ) : (
                        <Badge tone="neutral" title="Your own assessment">
                          Self-declared
                        </Badge>
                      )}
                    </p>
                    <p className="text-xs text-ink-subtle">
                      {guidance[skill.proficiencyLevel].label} · {skill.yearsExperience}{" "}
                      {skill.yearsExperience === 1 ? "year" : "years"}
                    </p>
                  </div>
                  <div className="ml-auto flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() => edit(skill)}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() => void remove(skill.skillSlug)}
                    >
                      Remove
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
