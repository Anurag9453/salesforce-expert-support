"use client";

import type { PricingTierView, TaxonomyCategory } from "@sfx/contracts";
import { countWords, MAX_DESCRIPTION_WORDS, MIN_DESCRIPTION_LENGTH } from "@sfx/contracts";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Alert, Badge, Field, Input, Textarea } from "@/components/ui";
import { AttachmentPicker, type PendingAttachment } from "./attachment-picker";
import { ChoiceCard, Progress, StepCard } from "./wizard-parts";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * "Get Expert Help" — the guided intake.
 *
 * This replaces the single-screen form. The one-textarea version was the right
 * shape when the only outcome was "find someone now"; it stops being right once
 * the customer has to choose a product, commit to a duration, and pay before
 * anything happens. Those are decisions, and decisions want their own steps.
 *
 * What has NOT changed is the principle underneath it: the customer describes a
 * problem, and we choose the expert (§39). Nothing in this flow asks them to
 * pick, rank, or even see a person.
 *
 * Ordering is deliberate and matches the money:
 *
 *   kind → duration → description → review → pay → *then* we start looking
 *
 * Payment before matching is D1. An expert who accepts is never left waiting on
 * a card, and if nobody is found we void an authorisation instead of reversing a
 * charge.
 */

const PLACEHOLDER = `Example: Our LWC on the Account page isn't refreshing after an imperative Apex call. We call refreshApex after the update but the wire never re-runs, so the user sees stale data until they reload.

What's broken, what have you already tried, and what does "fixed" look like?`;

type Kind = "instant" | "longterm";
type Step = "kind" | "duration" | "describe" | "identify" | "review" | "pay" | "longterm";

export function RequestWizard({
  categories,
  tiers,
  signedIn = true,
  payBeforeMatch = true,
}: {
  categories: TaxonomyCategory[];
  tiers: PricingTierView[];
  /** Anonymous visitors get an extra step; everyone else skips it entirely. */
  signedIn?: boolean;
  /**
   * Whether a payment is authorized before matching starts (D1).
   *
   * True under exclusive dispatch, where one expert gets an exclusive offer and
   * should never be handed work that is not already paid for. False under the
   * interest pool: the customer has not chosen anyone yet, so asking them to
   * authorize before they have seen who is available inverts the point of
   * showing them three people. There, payment follows the expert's confirmation.
   */
  payBeforeMatch?: boolean;
}) {
  const router = useRouter();

  const [step, setStep] = useState<Step>("kind");
  const [kind, setKind] = useState<Kind | null>(null);
  const [tierId, setTierId] = useState("");
  const [description, setDescription] = useState("");
  const [categorySlug, setCategorySlug] = useState<string | null>(null);
  const [skillSlugs, setSkillSlugs] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [leadSummary, setLeadSummary] = useState("");
  const [leadSent, setLeadSent] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [identified, setIdentified] = useState(signedIn);
  const [existingAccount, setExistingAccount] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tier = tiers.find((candidate) => candidate.id === tierId) ?? null;
  const trimmed = description.trim();
  const words = countWords(description);
  const overLimit = words > MAX_DESCRIPTION_WORDS;
  const describeReady = trimmed.length >= MIN_DESCRIPTION_LENGTH && !overLimit;

  const skillsForCategory = useMemo(
    () => categories.find((category) => category.slug === categorySlug)?.skills ?? [],
    [categories, categorySlug],
  );

  /*
    The rail only shows steps this visitor will actually see. Rendering a
    greyed-out "Your details" to someone already signed in would advertise a step
    that never arrives.
  */
  const steps: Step[] = [
    "kind",
    "duration",
    "describe",
    ...(identified ? [] : (["identify"] as Step[])),
    "review",
    // Dropped entirely rather than shown and skipped: a rail that advertises a
    // Payment step the customer never reaches is worse than one step shorter.
    ...(payBeforeMatch ? (["pay"] as Step[]) : []),
  ];
  const stepLabels = [
    "Type",
    "Duration",
    "Problem",
    ...(identified ? [] : ["You"]),
    "Review",
    ...(payBeforeMatch ? ["Payment"] : []),
  ];
  const stepIndex = steps.indexOf(step);
  const afterDescribe: Step = identified ? "review" : "identify";

  function choose(next: Kind) {
    setKind(next);
    setStep(next === "instant" ? "duration" : "longterm");
  }

  async function submitRequest() {
    if (!tier || submitting) return;
    setSubmitting(true);
    setError(null);

    const response = await fetch("/api/v1/requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        description: trimmed,
        pricingTierId: tier.id,
        ...(categorySlug ? { categorySlug } : {}),
        ...(skillSlugs.length > 0 ? { skillSlugs } : {}),
        ...(attachments.length > 0
          ? { attachmentIds: attachments.filter((a) => a.uploaded).map((a) => a.id) }
          : {}),
      }),
    });
    const body = await response.json();

    if (!body.ok) {
      setError(body.error.message);
      setSubmitting(false);
      return;
    }

    // The search starts server-side the moment this returns, so the customer
    // lands on the live status page rather than a receipt.
    router.push(`/request/${body.data.request.id}`);
    router.refresh();
  }

  /**
   * Creates the account and continues. No password is asked for or set — see
   * `/api/v1/guest`.
   */
  async function identify() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/guest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), email: email.trim() }),
      });
      const body = await response.json();
      if (!body.ok) {
        setError(body.error.message);
        return;
      }
      if (body.data.existingAccount) {
        // Never silently sign them in on an email alone — that would be account
        // takeover with a guessable credential.
        setExistingAccount(true);
        return;
      }
      setIdentified(true);
      setStep("review");
    } catch {
      setError("Could not reach the server. Check your connection.");
    } finally {
      setSubmitting(false);
    }
  }

  async function sendLead() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const response = await fetch("/api/v1/leads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ summary: leadSummary.trim() }),
    });
    const body = await response.json();
    setSubmitting(false);
    if (!body.ok) {
      setError(body.error.message);
      return;
    }
    setLeadSent(true);
  }

  return (
    <div className="space-y-5">
      {kind === "instant" && <Progress index={stepIndex} labels={stepLabels} />}
      {error && <Alert tone="danger">{error}</Alert>}

      {/* ── 1. Which kind of help ────────────────────────────────────────── */}
      {step === "kind" && (
        <div className="stagger grid gap-4 sm:grid-cols-2">
          <ChoiceCard
            title="Instant support"
            lede="Something is broken now."
            body="Describe the problem, pay, and we start looking immediately. Most requests reach an expert within 15 minutes."
            badge={<Badge tone="available">Usually under 15 min</Badge>}
            action="Get help now"
            onSelect={() => choose("instant")}
          />
          <ChoiceCard
            title="Long-term support"
            lede="Ongoing help, not a one-off."
            body="Retainers and continuing engagements. We are not selling this yet — tell us what you need and a human will get back to you."
            badge={<Badge>Not open yet</Badge>}
            action="Tell us what you need"
            onSelect={() => choose("longterm")}
          />
        </div>
      )}

      {/* ── 2. Duration ──────────────────────────────────────────────────── */}
      {step === "duration" && (
        <StepCard
          title="How long do you need?"
          hint="You can extend the call later if it runs over."
          onBack={() => setStep("kind")}
          onNext={() => setStep("describe")}
          nextDisabled={!tier}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            {tiers.map((option) => {
              const active = option.id === tierId;
              return (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setTierId(option.id)}
                  className={cn(
                    "interactive rounded-xl border p-4 text-left",
                    active
                      ? "border-accent bg-accent-subtle shadow-raised"
                      : "border-border-strong bg-surface-raised hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-raised",
                  )}
                >
                  <span
                    data-numeric
                    className={cn(
                      "font-display block text-2xl leading-none font-medium",
                      active ? "text-accent" : "text-ink",
                    )}
                  >
                    {formatMoney(option.priceCents, option.currency)}
                  </span>
                  <span className="mt-1.5 block text-sm text-ink">
                    {option.durationMinutes} minutes
                  </span>
                </button>
              );
            })}
          </div>
        </StepCard>
      )}

      {/* ── 3. Describe ──────────────────────────────────────────────────── */}
      {step === "describe" && (
        <StepCard
          title="What's going wrong?"
          onBack={() => setStep("duration")}
          onNext={() => setStep(afterDescribe)}
          nextDisabled={!describeReady}
        >
          {/*
            The alert says why precision helps rather than merely demanding it.
            "Be specific" is nagging; "this is what we match on" is a reason.
          */}
          <Alert tone="info" title="The more precise you are, the better we can match you">
            We read this to work out which skills your problem actually needs, and route it to
            someone proven at that depth. Error messages, object and field names, and what you have
            already tried all help. Never include passwords, tokens, keys, or production customer
            data.
          </Alert>

          <div className="mt-4 space-y-2">
            <Textarea
              id="description"
              rows={12}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={PLACEHOLDER}
              invalid={overLimit}
              aria-describedby="description-count"
            />
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span id="description-count" data-numeric className="text-ink-subtle">
                {/* Counts up, and only turns red once it is actually a problem. */}
                <span className={cn(overLimit && "font-medium text-danger")}>{words}</span>
                {" / "}
                {MAX_DESCRIPTION_WORDS} words
              </span>
              {overLimit && (
                <span className="text-danger">
                  Trim it down before continuing — the limit keeps this readable for the expert.
                </span>
              )}
            </div>
          </div>

          <details className="mt-5 rounded-xl border border-border bg-surface-sunken p-4">
            <summary className="cursor-pointer text-sm font-medium text-ink">
              Add detail (optional)
            </summary>
            <div className="mt-4 space-y-5">
              <div className="space-y-2">
                <p className="text-sm font-medium text-ink">Which area is this in?</p>
                <p className="text-xs text-ink-subtle">
                  Only if you already know — we work it out from your description either way, and
                  guessing wrong costs you nothing.
                </p>
                <div className="flex flex-wrap gap-2 pt-1">
                  {categories.map((category) => {
                    const active = categorySlug === category.slug;
                    return (
                      <button
                        key={category.slug}
                        type="button"
                        aria-pressed={active}
                        onClick={() => {
                          setCategorySlug(active ? null : category.slug);
                          setSkillSlugs([]);
                        }}
                        className={cn(
                          "interactive rounded-md border px-3 py-1.5 text-xs",
                          active
                            ? "border-accent/40 bg-accent-subtle font-medium text-accent shadow-flat"
                            : "border-border bg-surface-raised text-ink-muted hover:border-border-strong hover:bg-surface-sunken",
                        )}
                      >
                        {category.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              {skillsForCategory.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm font-medium text-ink">Anything specific?</p>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {skillsForCategory.map((skill) => {
                      const active = skillSlugs.includes(skill.slug);
                      return (
                        <button
                          key={skill.slug}
                          type="button"
                          aria-pressed={active}
                          onClick={() =>
                            setSkillSlugs((current) =>
                              active
                                ? current.filter((slug) => slug !== skill.slug)
                                : [...current, skill.slug],
                            )
                          }
                          className={cn(
                            "interactive rounded-md border px-3 py-1.5 text-xs",
                            active
                              ? "border-accent/40 bg-accent-subtle font-medium text-accent shadow-flat"
                              : "border-border bg-surface-raised text-ink-muted hover:border-border-strong hover:bg-surface-sunken",
                          )}
                        >
                          {skill.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <AttachmentPicker attachments={attachments} onChange={setAttachments} />
            </div>
          </details>
        </StepCard>
      )}

      {/* ── 3b. Who are you (anonymous visitors only) ────────────────────── */}
      {step === "identify" && (
        <StepCard
          title="Where should we reach you?"
          hint="No password needed. You can set one later if you want."
          onBack={() => setStep("describe")}
          onNext={() => void identify()}
          nextLabel={submitting ? "Saving…" : "Continue"}
          nextDisabled={submitting || name.trim() === "" || !email.includes("@")}
        >
          {/*
            Asked *after* they have written the problem, not before. Someone with
            a broken org will describe it; being stopped at a form first is where
            they leave.
          */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="guest-name" label="Your name" required>
              <Input
                id="guest-name"
                value={name}
                autoComplete="name"
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field id="guest-email" label="Email" required hint="For your receipt and updates.">
              <Input
                id="guest-email"
                type="email"
                value={email}
                autoComplete="email"
                invalid={existingAccount}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setExistingAccount(false);
                }}
              />
            </Field>
          </div>

          {existingAccount ? (
            <Alert tone="warning" className="mt-4" title="That email already has an account">
              Sign in and we will keep everything you have written so far.{" "}
              <a
                href={`/login?next=${encodeURIComponent("/request-help")}`}
                className="font-medium text-accent underline-offset-2 hover:underline"
              >
                Sign in
              </a>
            </Alert>
          ) : (
            <p className="mt-4 text-xs leading-relaxed text-ink-subtle">
              We create an account so you can follow the match live and come back to this request.
              Already have one?{" "}
              <a
                href={`/login?next=${encodeURIComponent("/request-help")}`}
                className="text-accent underline-offset-2 hover:underline"
              >
                Sign in instead
              </a>
              .
            </p>
          )}
        </StepCard>
      )}

      {/* ── 4. Review ────────────────────────────────────────────────────── */}
      {step === "review" && tier && (
        <StepCard
          title="Does this look right?"
          hint={
            payBeforeMatch
              ? "Nothing is charged and no expert is contacted until the next step."
              : "We will start looking straight away. You are not charged anything yet."
          }
          onBack={() => setStep("describe")}
          onNext={payBeforeMatch ? () => setStep("pay") : () => void submitRequest()}
          nextLabel={
            payBeforeMatch
              ? "Continue to payment"
              : submitting
                ? "Starting the search…"
                : "Find me an expert"
          }
          nextDisabled={!payBeforeMatch && submitting}
        >
          <dl className="divide-y divide-border">
            <Row label="Type">Instant support</Row>
            <Row label="Session">
              {tier.durationMinutes} minutes · {formatMoney(tier.priceCents, tier.currency)}
            </Row>
            <Row label="Your problem">
              <span className="line-clamp-6 whitespace-pre-wrap">{trimmed}</span>
              <button
                type="button"
                onClick={() => setStep("describe")}
                className="interactive mt-2 block text-xs text-accent hover:underline"
              >
                Edit
              </button>
            </Row>
            {categorySlug && (
              <Row label="Area">{categories.find((c) => c.slug === categorySlug)?.name}</Row>
            )}
            {attachments.length > 0 && <Row label="Attachments">{attachments.length} file(s)</Row>}
          </dl>
        </StepCard>
      )}

      {/* ── 5. Pay ───────────────────────────────────────────────────────── */}
      {step === "pay" && tier && (
        <StepCard
          title="Payment"
          onBack={() => setStep("review")}
          onNext={() => void submitRequest()}
          nextLabel={
            submitting ? "Authorising…" : `Authorise ${formatMoney(tier.priceCents, tier.currency)}`
          }
          nextDisabled={submitting}
        >
          <div className="flex items-baseline justify-between gap-4 border-b border-border pb-4">
            <span className="text-sm text-ink-muted">{tier.durationMinutes}-minute session</span>
            <span data-numeric className="font-display text-3xl font-medium text-ink">
              {formatMoney(tier.priceCents, tier.currency)}
            </span>
          </div>

          <Alert tone="info" className="mt-4" title="You are not charged yet">
            We place a hold now and take payment once your session actually happens. If we cannot
            find the right expert, the hold is released and you pay nothing.
          </Alert>

          {/*
            No card fields. The payment provider is still undecided, so a
            realistic-looking card form here would be a form that collects real
            card numbers and sends them nowhere — the one thing this screen must
            never be. It arrives with the provider.
          */}
          <p className="mt-4 text-xs leading-relaxed text-ink-subtle">
            Card entry arrives with the payment provider. In this build the hold is placed through
            the mock gateway, so no real payment method is collected or charged.
          </p>
        </StepCard>
      )}

      {/* ── Long-term: lead capture only ─────────────────────────────────── */}
      {step === "longterm" &&
        (leadSent ? (
          <Alert tone="success" title="Thanks — we have it">
            We will get back to you about ongoing support. If something breaks in the meantime,
            start an instant request instead.
          </Alert>
        ) : (
          <StepCard
            title="Long-term support"
            hint="Not open yet — this reaches a human, not a matching engine."
            onBack={() => setStep("kind")}
            onNext={() => void sendLead()}
            nextLabel={submitting ? "Sending…" : "Send"}
            nextDisabled={submitting || leadSummary.trim().length < MIN_DESCRIPTION_LENGTH}
          >
            <Alert tone="warning" title="We are not selling this yet">
              Ongoing engagements are still being designed, so there is no price and no timeline to
              quote you. Tell us what you need and someone will follow up.
            </Alert>
            <Textarea
              className="mt-4"
              rows={8}
              value={leadSummary}
              onChange={(event) => setLeadSummary(event.target.value)}
              placeholder="What would ongoing support look like for you? Roughly how much, how often, and on what?"
            />
          </StepCard>
        ))}
    </div>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────

/** Where you are, and how much is left. Named steps beat a percentage. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-4 py-3">
      <dt className="text-xs tracking-wide text-ink-subtle uppercase">{label}</dt>
      <dd className="min-w-0 text-sm text-ink">{children}</dd>
    </div>
  );
}
