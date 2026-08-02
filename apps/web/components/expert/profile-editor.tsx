"use client";

import type { ExpertApplication, UpdateExpertProfileInput } from "@sfx/contracts";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Textarea,
} from "@/components/ui";

/**
 * Profile editing after approval (requirement 8).
 *
 * The form contains exactly the self-editable fields. That is a presentation
 * choice and nothing more: the guarantee lives in the domain's allowlist, so a
 * hand-crafted PATCH carrying `status` or `verified` is rejected by the schema
 * and stripped by the service regardless of what this component renders.
 *
 * The administrative fields are shown read-only rather than hidden. An expert
 * who cannot see their own status, review notes, or verification state has to
 * ask someone; showing them and marking them as ours to change is more honest
 * than pretending they do not exist.
 */
export function ProfileEditor({ profile }: { profile: ExpertApplication }) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    setFieldErrors({});

    const form = new FormData(event.currentTarget);
    const payload: UpdateExpertProfileInput = {
      country: String(form.get("country") ?? "").trim(),
      timezone: String(form.get("timezone") ?? "").trim(),
      yearsExperience: Number(form.get("yearsExperience") ?? 0),
      professionalSummary: String(form.get("professionalSummary") ?? "").trim(),
      employmentStatus: String(form.get("employmentStatus") ?? "").trim(),
      linkedinUrl: String(form.get("linkedinUrl") ?? "").trim(),
      githubUrl: String(form.get("githubUrl") ?? "").trim(),
      languages: splitList(form.get("languages")),
      certifications: splitList(form.get("certifications")),
    };

    try {
      const response = await fetch("/api/v1/expert/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (body.ok) {
        setMessage({ tone: "success", text: "Saved." });
        router.refresh();
      } else {
        setFieldErrors(body.error?.fields ?? {});
        setMessage({ tone: "danger", text: body.error?.message ?? "Could not save your profile." });
      }
    } catch {
      setMessage({ tone: "danger", text: "Could not reach the server. Try again." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-6">
      {message && <Alert tone={message.tone}>{message.text}</Alert>}

      <Card>
        <CardHeader>
          <CardTitle>About you</CardTitle>
        </CardHeader>
        <CardBody className="space-y-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <Field id="country" label="Country" required error={fieldErrors.country}>
              <Input id="country" name="country" defaultValue={profile.country ?? ""} />
            </Field>
            <Field
              id="timezone"
              label="Time zone"
              hint="IANA name, e.g. Asia/Kolkata."
              required
              error={fieldErrors.timezone}
            >
              <Input id="timezone" name="timezone" defaultValue={profile.timezone ?? ""} />
            </Field>
          </div>

          <Field
            id="yearsExperience"
            label="Years of Salesforce experience"
            hint="Overall. Years per individual skill live on the skills page."
            required
            error={fieldErrors.yearsExperience}
          >
            <Input
              id="yearsExperience"
              name="yearsExperience"
              type="number"
              min={0}
              max={60}
              defaultValue={profile.yearsExperience ?? 0}
            />
          </Field>

          <Field
            id="professionalSummary"
            label="Professional summary"
            hint="How a reviewer — and later a customer reading about who they were matched with — understands your depth."
            required
            error={fieldErrors.professionalSummary}
          >
            <Textarea
              id="professionalSummary"
              name="professionalSummary"
              rows={6}
              defaultValue={profile.professionalSummary ?? ""}
            />
          </Field>

          <Field id="employmentStatus" label="Current role" error={fieldErrors.employmentStatus}>
            <Input
              id="employmentStatus"
              name="employmentStatus"
              defaultValue={profile.employmentStatus ?? ""}
            />
          </Field>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              id="languages"
              label="Languages"
              hint="Comma-separated ISO codes, e.g. en, hi."
              error={fieldErrors.languages}
            >
              <Input id="languages" name="languages" defaultValue={profile.languages.join(", ")} />
            </Field>
            <Field
              id="certifications"
              label="Certifications"
              hint="Comma-separated."
              error={fieldErrors.certifications}
            >
              <Input
                id="certifications"
                name="certifications"
                defaultValue={profile.certifications.join(", ")}
              />
            </Field>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field id="linkedinUrl" label="LinkedIn" error={fieldErrors.linkedinUrl}>
              <Input id="linkedinUrl" name="linkedinUrl" defaultValue={profile.linkedinUrl ?? ""} />
            </Field>
            <Field id="githubUrl" label="GitHub" error={fieldErrors.githubUrl}>
              <Input id="githubUrl" name="githubUrl" defaultValue={profile.githubUrl ?? ""} />
            </Field>
          </div>

          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </CardBody>
      </Card>
    </form>
  );
}

function splitList(value: FormDataEntryValue | null): string[] {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
