"use client";

import type { ExpertApplication } from "@sfx/contracts";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Checkbox,
  CountryTimeZoneFields,
  Field,
  Input,
  Textarea,
} from "@/components/ui";

/**
 * The onboarding form (§9).
 *
 * Editable only while the application is the applicant's — DRAFT or REJECTED.
 * The `readOnly` flag here mirrors a policy decision the server has already
 * made; it hides controls that would 403 anyway rather than deciding anything.
 */
const FIELD_LABELS: Record<string, string> = {
  country: "Country",
  timezone: "Time zone",
  yearsExperience: "Years of Salesforce experience",
  phone: "Phone number",
  trailheadUrl: "Trailhead profile",
  professionalSummary: "Professional summary",
  termsAcceptedAt: "Terms acceptance",
  confidentialityAcceptedAt: "Confidentiality acceptance",
};

export function ExpertApplicationForm({
  application,
  readOnly,
}: {
  application: ExpertApplication;
  readOnly: boolean;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    setFieldErrors({});

    const form = new FormData(event.currentTarget);
    const payload = {
      country: String(form.get("country") ?? ""),
      timezone: String(form.get("timezone") ?? ""),
      yearsExperience: Number(form.get("yearsExperience") ?? 0),
      professionalSummary: String(form.get("professionalSummary") ?? ""),
      phone: String(form.get("phone") ?? ""),
      trailheadUrl: String(form.get("trailheadUrl") ?? ""),
      linkedinUrl: String(form.get("linkedinUrl") ?? ""),
      githubUrl: String(form.get("githubUrl") ?? ""),
      employmentStatus: String(form.get("employmentStatus") ?? ""),
      languages: String(form.get("languages") ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      certifications: String(form.get("certifications") ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      acceptTerms: form.get("acceptTerms") === "on",
      acceptConfidentiality: form.get("acceptConfidentiality") === "on",
    };

    const response = await fetch("/api/v1/expert-application", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json();

    if (!body.ok) {
      setFieldErrors(body.error.fields ?? {});
      setMessage({ tone: "danger", text: body.error.message });
    } else {
      setMessage({ tone: "success", text: "Saved." });
      router.refresh();
    }
    setSaving(false);
  }

  async function submit() {
    setSubmitting(true);
    setMessage(null);
    setFieldErrors({});

    const response = await fetch("/api/v1/expert-application/submit", { method: "POST" });
    const body = await response.json();

    if (!body.ok) {
      setFieldErrors(body.error.fields ?? {});
      setMessage({
        tone: "danger",
        text: body.error.message,
      });
    } else {
      router.refresh();
    }
    setSubmitting(false);
  }

  const outstanding = application.missingForSubmission;

  return (
    <div className="space-y-5">
      {message && <Alert tone={message.tone}>{message.text}</Alert>}

      {application.status === "REJECTED" && application.reviewNotes && (
        <Alert tone="warning" title="This application was not approved">
          <p>{application.reviewNotes}</p>
          <p className="mt-2">Editing any field reopens it as a draft so you can resubmit.</p>
        </Alert>
      )}

      <form onSubmit={save} className="space-y-5" noValidate>
        <Card>
          <CardHeader>
            <CardTitle>About you</CardTitle>
          </CardHeader>
          <CardBody className="grid gap-4 sm:grid-cols-2">
            {/* Spans the row: two dependent selects that belong together. */}
            <div className="sm:col-span-2">
              <CountryTimeZoneFields
                defaultCountry={application.country}
                defaultTimezone={application.timezone}
                countryError={fieldErrors.country}
                timezoneError={fieldErrors.timezone}
                disabled={readOnly}
                required
              />
            </div>

            <Field
              id="yearsExperience"
              label="Years of Salesforce experience"
              required
              error={fieldErrors.yearsExperience}
            >
              <Input
                id="yearsExperience"
                name="yearsExperience"
                type="number"
                min={0}
                max={60}
                defaultValue={application.yearsExperience ?? 0}
                disabled={readOnly}
                invalid={Boolean(fieldErrors.yearsExperience)}
              />
            </Field>

            {/*
              Both required before submission, and both are vetting rather than
              profile: the phone is how we reach this person when a session goes
              wrong, and the Trailhead profile is the one claim on this form a
              reviewer can independently check in under a minute.
            */}
            <Field id="phone" label="Phone number" required error={fieldErrors.phone}>
              <Input
                id="phone"
                name="phone"
                type="tel"
                autoComplete="tel"
                placeholder="+91 98765 43210"
                defaultValue={application.phone ?? ""}
                disabled={readOnly}
                invalid={Boolean(fieldErrors.phone)}
              />
            </Field>

            <Field
              id="trailheadUrl"
              label="Trailhead profile"
              hint="Your public Trailblazer profile. We check your certifications against it."
              required
              error={fieldErrors.trailheadUrl}
            >
              <Input
                id="trailheadUrl"
                name="trailheadUrl"
                type="url"
                placeholder="https://www.salesforce.com/trailblazer/yourprofile"
                defaultValue={application.trailheadUrl ?? ""}
                disabled={readOnly}
                invalid={Boolean(fieldErrors.trailheadUrl)}
              />
            </Field>

            <Field
              id="employmentStatus"
              label="Current employment"
              hint="Optional."
              error={fieldErrors.employmentStatus}
            >
              <Input
                id="employmentStatus"
                name="employmentStatus"
                defaultValue={application.employmentStatus ?? ""}
                disabled={readOnly}
              />
            </Field>

            <Field
              id="professionalSummary"
              label="Professional summary"
              hint="What you work on, and the problems you are strongest at."
              required
              error={fieldErrors.professionalSummary}
              className="sm:col-span-2"
            >
              <Textarea
                id="professionalSummary"
                name="professionalSummary"
                rows={5}
                defaultValue={application.professionalSummary ?? ""}
                disabled={readOnly}
                invalid={Boolean(fieldErrors.professionalSummary)}
              />
            </Field>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Background</CardTitle>
          </CardHeader>
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field id="languages" label="Languages" hint="Comma separated ISO codes, e.g. en, hi">
              <Input
                id="languages"
                name="languages"
                defaultValue={application.languages.join(", ")}
                disabled={readOnly}
              />
            </Field>

            <Field id="certifications" label="Certifications" hint="Comma separated.">
              <Input
                id="certifications"
                name="certifications"
                defaultValue={application.certifications.join(", ")}
                disabled={readOnly}
              />
            </Field>

            <Field
              id="linkedinUrl"
              label="LinkedIn"
              hint="Optional."
              error={fieldErrors.linkedinUrl}
            >
              <Input
                id="linkedinUrl"
                name="linkedinUrl"
                type="url"
                defaultValue={application.linkedinUrl ?? ""}
                disabled={readOnly}
                invalid={Boolean(fieldErrors.linkedinUrl)}
              />
            </Field>

            <Field id="githubUrl" label="GitHub" hint="Optional." error={fieldErrors.githubUrl}>
              <Input
                id="githubUrl"
                name="githubUrl"
                type="url"
                defaultValue={application.githubUrl ?? ""}
                disabled={readOnly}
                invalid={Boolean(fieldErrors.githubUrl)}
              />
            </Field>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Agreements</CardTitle>
          </CardHeader>
          <CardBody className="space-y-4">
            <Checkbox
              id="acceptTerms"
              name="acceptTerms"
              defaultChecked={Boolean(application.termsAcceptedAt)}
              disabled={readOnly}
              label="I accept the platform terms."
            />
            <Checkbox
              id="acceptConfidentiality"
              name="acceptConfidentiality"
              defaultChecked={Boolean(application.confidentialityAcceptedAt)}
              disabled={readOnly}
              label="I accept the confidentiality terms."
              description="Customers may share org configuration and code during a session. Passwords, access tokens, private keys and production customer data are prohibited on this platform — Health Cloud technical support is in scope, actual patient data is not."
            />
          </CardBody>
        </Card>

        {!readOnly && (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="secondary" disabled={saving || submitting}>
              {saving ? "Saving…" : "Save draft"}
            </Button>
            <Button
              onClick={() => void submit()}
              disabled={saving || submitting || outstanding.length > 0}
            >
              {submitting ? "Submitting…" : "Submit for review"}
            </Button>
            {outstanding.length > 0 && (
              <p className="text-xs text-ink-subtle">
                Still needed: {outstanding.map((f) => FIELD_LABELS[f] ?? f).join(", ")}. Save first.
              </p>
            )}
          </div>
        )}
      </form>
    </div>
  );
}
