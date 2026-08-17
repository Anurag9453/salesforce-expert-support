"use client";

import type { PricingTierView } from "@sfx/contracts";
import { countWords, MAX_DESCRIPTION_WORDS, MIN_DESCRIPTION_LENGTH } from "@sfx/contracts";
import { useState } from "react";
import { Alert, Badge, Card, CardBody, Field, Input, Textarea } from "@/components/ui";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Progress, StepCard } from "./wizard-parts";

/**
 * The whole customer-facing product: ask, leave your details, hear back.
 *
 * Three steps and no account. Every gate that used to sit here — sign-up,
 * payment, matching — has been removed rather than hidden, because each one was
 * a place where somebody who wanted help gave up instead.
 *
 * The duration is still asked for and still priced, even though nothing is
 * charged. It is the single most useful qualifying question the sales team can
 * have before they call: it says how big the problem is and what the person
 * expects to pay.
 */

const PLACEHOLDER = `Example: Our LWC on the Account page isn't refreshing after an imperative Apex call. We call refreshApex after the update but the wire never re-runs, so the user sees stale data until they reload.`;

type Step = "duration" | "describe" | "details" | "done";

const STEP_LABELS = ["Duration", "Problem", "Your details"] as const;
const STEPS: Step[] = ["duration", "describe", "details"];

export function LeadWizard({ tiers }: { tiers: PricingTierView[] }) {
  const [step, setStep] = useState<Step>("duration");
  const [tierId, setTierId] = useState("");
  const [description, setDescription] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const tier = tiers.find((t) => t.id === tierId) ?? null;
  const trimmed = description.trim();
  const words = countWords(trimmed);
  const describeReady = trimmed.length >= MIN_DESCRIPTION_LENGTH && words <= MAX_DESCRIPTION_WORDS;
  const detailsReady = name.trim() !== "" && email.includes("@") && phone.trim().length >= 6;

  async function submit() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      const response = await fetch("/api/v1/leads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          phone: phone.trim(),
          summary: trimmed,
          ...(tier ? { pricingTierId: tier.id } : {}),
        }),
      });
      const body = await response.json();
      if (!body.ok) {
        setError(body.error.message);
        setFieldErrors(body.error.fields ?? {});
        return;
      }
      setStep("done");
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Sent ──────────────────────────────────────────────────────────────────

  if (step === "done") {
    return (
      <Card accent className="animate-scale-in">
        <CardBody className="space-y-4 p-8 text-center">
          <Badge tone="available">Received</Badge>
          <h2 className="font-display text-2xl leading-snug font-medium text-balance text-ink">
            Thanks — we&rsquo;ll get back to you shortly.
          </h2>
          <p className="mx-auto max-w-md text-sm leading-relaxed text-ink-muted">
            One of our team will read what you&rsquo;ve sent and contact you on{" "}
            <span className="text-ink">{email.trim()}</span> to match you with the right Salesforce
            expert.
          </p>
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Progress index={STEPS.indexOf(step)} labels={STEP_LABELS} />

      {step === "duration" && (
        <StepCard
          title="How long do you think you need?"
          hint="A rough idea is fine — it helps us match the right person. Nothing is charged now."
          onBack={() => undefined}
          onNext={() => setStep("describe")}
          nextDisabled={!tier}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            {tiers.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setTierId(option.id)}
                className={cn(
                  "interactive rounded-xl border p-5 text-left transition-colors",
                  tierId === option.id
                    ? "border-accent bg-accent-subtle shadow-raised"
                    : "border-border bg-surface-raised hover:border-accent/40",
                )}
              >
                <span className="font-display block text-lg font-medium text-ink">
                  {option.durationMinutes} minutes
                </span>
                <span data-numeric className="mt-1 block text-2xl font-medium text-accent">
                  {formatMoney(option.priceCents, option.currency)}
                </span>
              </button>
            ))}
          </div>
        </StepCard>
      )}

      {step === "describe" && (
        <StepCard
          title="What do you need help with?"
          hint="In your own words. The more specific you are, the better we can match you."
          onBack={() => setStep("duration")}
          onNext={() => setStep("details")}
          nextDisabled={!describeReady}
        >
          <Field
            id="lead-problem"
            label="Your problem"
            hint={`${String(words)} of ${String(MAX_DESCRIPTION_WORDS)} words`}
          >
            <Textarea
              rows={8}
              value={description}
              placeholder={PLACEHOLDER}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>

          {/*
            Said plainly, because this box is public and whatever lands in it is
            read by our team. The scanner catches pasted keys and `key=value`
            secrets, but it cannot catch someone *describing* a password in a
            sentence — so the warning does the part the code cannot.
          */}
          <Alert tone="warning" className="mt-4" title="Please don't include">
            Passwords, security tokens, API keys, or real customer data. Describe the problem — we
            never need your credentials to help with it.
          </Alert>
        </StepCard>
      )}

      {step === "details" && (
        <StepCard
          title="How can we reach you?"
          hint="We'll use this to get back to you — usually the same working day."
          onBack={() => setStep("describe")}
          onNext={() => void submit()}
          nextLabel={submitting ? "Sending…" : "Send my request"}
          nextDisabled={!detailsReady || submitting}
        >
          <div className="space-y-4">
            <Field id="lead-name" label="Your name" error={fieldErrors.name}>
              <Input
                value={name}
                autoComplete="name"
                placeholder="Priya Raghavan"
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field id="lead-email" label="Email" error={fieldErrors.email}>
              <Input
                type="email"
                value={email}
                autoComplete="email"
                placeholder="you@company.com"
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
            <Field id="lead-phone" label="Phone" error={fieldErrors.phone}>
              <Input
                type="tel"
                value={phone}
                autoComplete="tel"
                placeholder="+91 98765 43210"
                onChange={(event) => setPhone(event.target.value)}
              />
            </Field>
          </div>

          {tier && (
            <p className="mt-5 border-t border-border pt-4 text-sm text-ink-muted">
              You asked for{" "}
              <span className="text-ink">
                {tier.durationMinutes} minutes · {formatMoney(tier.priceCents, tier.currency)}
              </span>
              . Nothing is charged now — we&rsquo;ll agree everything with you first.
            </p>
          )}

          {error && (
            <Alert tone="danger" className="mt-4">
              {error}
            </Alert>
          )}
        </StepCard>
      )}
    </div>
  );
}
