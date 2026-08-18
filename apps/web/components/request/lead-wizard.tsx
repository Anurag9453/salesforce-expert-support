"use client";

import type { PricingTierView } from "@sfx/contracts";
import {
  CERTIFICATION_HELP_OPTIONS,
  CERTIFICATION_TRACKS,
  CERTIFICATION_UNDECIDED,
  TIME_ZONE_META,
} from "@sfx/contracts";
import { countWords, MAX_DESCRIPTION_WORDS, MIN_DESCRIPTION_LENGTH } from "@sfx/contracts";
import type React from "react";
import { useState } from "react";
import {
  Alert,
  Badge,
  Card,
  CardBody,
  Checkbox,
  Field,
  Input,
  Select,
  Textarea,
} from "@/components/ui";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ChoiceCard, Progress, StepCard } from "./wizard-parts";

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

/** Pluralised for the review summary, where the number sits next to the word. */
const UNIT_LABELS: Record<string, string> = {
  WEEK: "weeks",
  MONTH: "months",
  YEAR: "years",
};

/**
 * The zone picklist, ordered the way somebody actually looks for their own zone.
 *
 * Sorted by current UTC offset rather than alphabetically: people scan by
 * "roughly where I am", and an alphabetical list puts Auckland next to Anchorage.
 * The offsets are computed once at module load, not per render — this is four
 * hundred `Intl` formatters, which is cheap once and wasteful sixty times a
 * second.
 */
const ZONE_OFFSETS = new Map<string, number>(
  Object.keys(TIME_ZONE_META).map((zone) => [zone, offsetMinutes(zone)]),
);

const ZONE_OPTIONS = [...ZONE_OFFSETS.keys()].sort((a, b) => {
  const byOffset = (ZONE_OFFSETS.get(a) ?? 0) - (ZONE_OFFSETS.get(b) ?? 0);
  return byOffset !== 0 ? byOffset : a.localeCompare(b);
});

/** The zone's current offset from UTC, in minutes. */
function offsetMinutes(timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(new Date())
      .find((part) => part.type === "timeZoneName")?.value;
    const match = /GMT([+-])(\d{1,2}):?(\d{2})?/.exec(parts ?? "");
    if (!match) return 0;
    const sign = match[1] === "-" ? -1 : 1;
    return sign * (Number(match[2]) * 60 + Number(match[3] ?? 0));
  } catch {
    return 0;
  }
}

/** "Asia/Kolkata · IST" — the id people recognise, plus the abbreviation. */
function zoneLabel(zone: string): string {
  const meta = TIME_ZONE_META[zone];
  const readable = zone.replace(/_/g, " ");
  return meta?.abbr ? `${readable} · ${meta.abbr}` : readable;
}

/** Today, in the browser's own clock. No exam was sat yesterday. */
function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** An hour from now, rounded up, in the browser's own clock. */
function minCallAt(): string {
  const soon = new Date(Date.now() + 60 * 60 * 1000);
  soon.setMinutes(0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(soon.getFullYear())}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}T${pad(soon.getHours())}:${pad(soon.getMinutes())}`;
}

/**
 * What the description step asks, which is not the same question each time.
 *
 * A certification enquiry is the odd one out: nothing is broken, so "what do you
 * need help with?" and a placeholder about a failing LWC both read as though the
 * form had not registered the answer given one step earlier. The example matters
 * more than the heading — people write to the shape of the example.
 */
const DESCRIBE_COPY: Record<
  Kind,
  { title: string; hint: string; label: string; placeholder: string }
> = {
  INSTANT: {
    title: "What do you need help with?",
    hint: "In your own words. The more specific you are, the better we can match you.",
    label: "Your problem",
    placeholder: `Example: Our LWC on the Account page isn't refreshing after an imperative Apex call. We call refreshApex after the update but the wire never re-runs, so the user sees stale data until they reload.`,
  },
  SCHEDULED: {
    title: "What do you need help with?",
    hint: "In your own words. The more specific you are, the better we can match you.",
    label: "Your problem",
    placeholder: `Example: Our nightly integration batch has started hitting a governor limit. We would like someone to walk through it with us rather than fix it blind.`,
  },
  LONG_TERM: {
    title: "What are you trying to achieve?",
    hint: "The shape of the work, roughly how much of it, and anything already in motion.",
    label: "What you need",
    placeholder: `Example: We have no in-house Salesforce developer. We need someone regular for Apex work, integrations, and reviewing what our admin builds.`,
  },
  CERTIFICATION: {
    title: "Where are you up to?",
    hint: "What you have covered, what is not landing, and whether a date is already booked.",
    label: "What you need",
    placeholder: `Example: Sitting Platform Developer I in about six weeks. Apex and triggers are fine but asynchronous processing and testing patterns are not sticking. Booked for 12 September.`,
  },
};

type Kind = "INSTANT" | "SCHEDULED" | "LONG_TERM" | "CERTIFICATION";
type Step =
  | "kind"
  | "duration"
  | "describe"
  | "when"
  | "scope"
  | "certification"
  | "details"
  | "review"
  | "done";

/**
 * Which questions each kind of enquiry asks, and what to call them.
 *
 * One table rather than a pair of arrays per kind, because the steps and their
 * progress labels have to stay the same length and in the same order — keeping
 * them side by side makes that visible instead of a convention to remember.
 *
 * The navigation is derived from these arrays too, so Back and Next cannot
 * disagree with the progress bar. Before this, each step named its own
 * neighbours: `onNext={() => setStep(longTerm ? "scope" : scheduled ? "when" :
 * "details")}` in one place and a different ternary in the next, which is four
 * chances to get one path wrong for every kind added.
 */
const FLOWS: Record<Kind, { steps: readonly Step[]; labels: readonly string[] }> = {
  /* Duration first, because it prices the request and shapes everything after. */
  INSTANT: {
    steps: ["kind", "duration", "describe", "details", "review"],
    labels: ["Type", "Duration", "Problem", "Your details", "Review"],
  },
  /* The instant path plus one question: when. */
  SCHEDULED: {
    steps: ["kind", "duration", "describe", "when", "details", "review"],
    labels: ["Type", "Duration", "Problem", "When", "Your details", "Review"],
  },
  /*
    No duration: nobody buying a retainer is choosing between thirty and sixty
    minutes, and asking would make the form look like it had not understood the
    answer they just gave.
  */
  LONG_TERM: {
    steps: ["kind", "describe", "scope", "details", "review"],
    labels: ["Type", "What you need", "Scope", "Your details", "Review"],
  },
  /*
    Which exam comes before anything else, because it is the only question whose
    answer changes what "help" means here — and no duration, for the same reason
    as the retainer: preparing for a certification is not a thirty-minute call.
    If it turns out people do want to buy a single coaching session, that is a
    duration step to add, not a decision this forecloses.
  */
  CERTIFICATION: {
    steps: ["kind", "certification", "describe", "details", "review"],
    labels: ["Type", "Certification", "What you need", "Your details", "Review"],
  },
};

export function LeadWizard({ tiers }: { tiers: PricingTierView[] }) {
  const [step, setStep] = useState<Step>("kind");
  const [kind, setKind] = useState<Kind | null>(null);
  const [tierId, setTierId] = useState("");
  const [description, setDescription] = useState("");
  const [title, setTitle] = useState("");
  const [engagementCount, setEngagementCount] = useState("");
  const [engagementUnit, setEngagementUnit] = useState("");
  const [budgetBasis, setBudgetBasis] = useState("MONTHLY");
  const [budgetAmount, setBudgetAmount] = useState("");
  const [budgetNegotiable, setBudgetNegotiable] = useState(false);
  const [certification, setCertification] = useState("");
  const [examDate, setExamDate] = useState("");
  const [helpNeeded, setHelpNeeded] = useState<readonly string[]>([]);
  const [callAt, setCallAt] = useState("");
  /*
    Pre-filled from the browser rather than left blank. Almost everyone wants
    their own zone, and `Intl` already knows it — asking them to find it in a list
    of four hundred is a question with an obvious answer.
  */
  const [callZone, setCallZone] = useState(() => {
    const guess = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return guess in TIME_ZONE_META ? guess : "";
  });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const longTerm = kind === "LONG_TERM";
  const scheduled = kind === "SCHEDULED";
  const certifying = kind === "CERTIFICATION";
  const flow = FLOWS[kind ?? "INSTANT"];
  const steps = flow.steps;
  const labels = flow.labels;
  /* Only the paths that asked for a duration have one to quote against. */
  const priced = !longTerm && !certifying;
  const tier = priced ? (tiers.find((t) => t.id === tierId) ?? null) : null;

  /*
    Back and Next read off the flow rather than naming steps. `kind` has no
    previous step and `review` has no next one; both are handled where they are
    rendered, so the fallbacks here are unreachable rather than meaningful.
  */
  /*
    Chooses the kind and moves to whatever that flow asks second. Reading the
    step out of the table means a flow can be reordered in one place instead of
    here as well — the old version hard-coded "duration" on two cards and
    "describe" on a third, which is where a reordered flow would strand someone.
  */
  const begin = (chosen: Kind) => {
    setKind(chosen);
    setStep(FLOWS[chosen].steps[1] ?? "details");
  };

  const at = steps.indexOf(step);
  const goBack = () => setStep(steps[at - 1] ?? "kind");
  const goNext = () => setStep(steps[at + 1] ?? "review");
  const trimmed = description.trim();
  const words = countWords(trimmed);
  /*
    Each path gates on what its own description step asks for. The title moved
    here from the scope step; "what kind of help" is asked here too, because it is
    the same question as the description in a countable form.

    The exam date is deliberately absent: it is optional, since plenty of people
    are studying before they book.
  */
  const describeReady =
    trimmed.length >= MIN_DESCRIPTION_LENGTH &&
    words <= MAX_DESCRIPTION_WORDS &&
    (!longTerm || title.trim() !== "") &&
    (!certifying || helpNeeded.length > 0);
  const detailsReady = name.trim() !== "" && email.includes("@") && phone.trim().length >= 6;
  const whenReady = callAt !== "" && callZone !== "";
  const certificationReady = certification !== "";
  const scopeReady =
    engagementCount !== "" &&
    engagementUnit !== "" &&
    budgetAmount.trim() !== "" &&
    Number(budgetAmount) >= 0;

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
          supportType: kind ?? "INSTANT",
          ...(scheduled ? { preferredCallAt: callAt, preferredTimezone: callZone } : {}),
          ...(certifying
            ? {
                certification,
                certificationHelp: helpNeeded,
                // Omitted rather than sent empty: the schema wants a date or
                // nothing, and "" is neither.
                ...(examDate ? { examDate } : {}),
              }
            : {}),
          ...(longTerm
            ? {
                title: title.trim(),
                engagementCount: Number(engagementCount),
                engagementUnit,
                budgetBasis,
                budgetAmount: Number(budgetAmount),
                budgetNegotiable,
              }
            : {}),
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
      <Progress index={steps.indexOf(step)} labels={labels} />

      {step === "kind" && (
        <div className="stagger grid gap-4 sm:grid-cols-2">
          <ChoiceCard
            title="Instant support"
            lede="Something is broken now."
            body="Describe the problem and tell us how long you think you need. We come back to you with the right expert, usually the same working day."
            badge={<Badge tone="available">One-off fix</Badge>}
            action="Get help now"
            onSelect={() => {
              begin("INSTANT");
            }}
          />
          <ChoiceCard
            title="Scheduled support"
            lede="You know when you want us."
            body="Same as instant help, but you pick the time. Tell us when suits and which time zone you are in, and we call you then."
            badge={<Badge tone="accent">Pick a time</Badge>}
            action="Choose a time"
            onSelect={() => {
              begin("SCHEDULED");
            }}
          />
          <ChoiceCard
            title="Long-term support"
            lede="Ongoing help, not a one-off."
            body="A retainer or a continuing engagement. Tell us what you are trying to achieve and we will work out the shape of it with you."
            badge={<Badge>Ongoing</Badge>}
            action="Tell us what you need"
            onSelect={() => {
              begin("LONG_TERM");
            }}
          />
          <ChoiceCard
            title="Certification support"
            lede="You are working towards an exam."
            body="Preparation for a specific Salesforce credential — study guidance, the parts that are not landing, or a mock run before you sit it."
            badge={<Badge tone="accent">Exam prep</Badge>}
            action="Choose a certification"
            onSelect={() => {
              begin("CERTIFICATION");
            }}
          />
        </div>
      )}

      {step === "duration" && (
        <StepCard
          title="How long do you think you need?"
          hint="A rough idea is fine — it helps us match the right person. Nothing is charged now."
          onBack={goBack}
          onNext={goNext}
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
          title={DESCRIBE_COPY[kind ?? "INSTANT"].title}
          hint={DESCRIBE_COPY[kind ?? "INSTANT"].hint}
          onBack={goBack}
          onNext={goNext}
          nextDisabled={!describeReady}
        >
          {/*
            Asked here rather than on the scope step, and above the description
            rather than below it: a title is the thing you write first when you
            are naming a piece of work, and separating it from the description it
            summarises meant writing the summary before the thing summarised.

            Long-term only. An instant request derives its title from the first
            sentence of the description, because somebody whose deploy is broken
            should not have to compose a subject line first.
          */}
          {longTerm && (
            <Field
              id="lead-title"
              label="Give this a title"
              hint="A line your account manager can recognise it by."
              required
              error={fieldErrors.title}
              className="mb-5"
            >
              <Input
                id="lead-title"
                value={title}
                placeholder="Ongoing Apex and integration support"
                onChange={(event) => setTitle(event.target.value)}
                invalid={Boolean(fieldErrors.title)}
              />
            </Field>
          )}

          {certifying && (
            <div className="mb-5 space-y-5">
              <Field
                id="lead-exam-date"
                label="When do you sit it?"
                hint="Leave this blank if you have not booked a date yet."
                error={fieldErrors.examDate}
              >
                {/*
                  A date, not a datetime — and so, unlike the callback step, no
                  time zone to ask for. An exam date is the same calendar day
                  everywhere, which is the one scheduling question that needs no
                  conversion.
                */}
                <Input
                  id="lead-exam-date"
                  type="date"
                  value={examDate}
                  min={today()}
                  onChange={(event) => setExamDate(event.target.value)}
                  invalid={Boolean(fieldErrors.examDate)}
                />
              </Field>

              <Field
                id="lead-help"
                label="What do you need help with?"
                hint="Pick everything that applies."
                required
                error={fieldErrors.certificationHelp}
              >
                {/*
                  Checkboxes rather than a second text box. These route to
                  different people — a study plan is a conversation, a weak topic
                  is a tutorial, a retake needs someone who asks what went wrong
                  first — and a sentence buried in the description does not.

                  The description below still matters and is still required: this
                  says which kind of help, and that says what is actually going on.
                */}
                <div className="space-y-2.5">
                  {CERTIFICATION_HELP_OPTIONS.map((option) => (
                    <Checkbox
                      key={option.value}
                      checked={helpNeeded.includes(option.value)}
                      onChange={(event) => {
                        setHelpNeeded((current) =>
                          event.target.checked
                            ? [...current, option.value]
                            : current.filter((value) => value !== option.value),
                        );
                      }}
                      label={option.label}
                    />
                  ))}
                </div>
              </Field>
            </div>
          )}

          <Field
            id="lead-problem"
            label={DESCRIBE_COPY[kind ?? "INSTANT"].label}
            hint={`${String(words)} of ${String(MAX_DESCRIPTION_WORDS)} words`}
          >
            <Textarea
              rows={8}
              value={description}
              placeholder={DESCRIBE_COPY[kind ?? "INSTANT"].placeholder}
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

      {step === "when" && (
        <StepCard
          title="When shall we call you?"
          hint="Your local time. We confirm before anyone picks up the phone."
          onBack={goBack}
          onNext={goNext}
          nextDisabled={!whenReady}
        >
          <div className="space-y-4">
            <Field
              id="lead-call-at"
              label="Preferred date and time"
              required
              error={fieldErrors.preferredCallAt}
            >
              <Input
                id="lead-call-at"
                type="datetime-local"
                value={callAt}
                /*
                  No past times. `min` is advisory — a browser will let a
                  determined person past it and the server does not currently
                  reject a past instant, which is a gap worth knowing about
                  rather than one this attribute closes.
                */
                min={minCallAt()}
                onChange={(event) => setCallAt(event.target.value)}
                invalid={Boolean(fieldErrors.preferredCallAt)}
              />
            </Field>

            <Field
              id="lead-call-zone"
              label="Your time zone"
              hint="Pre-filled from your device. Change it if that is wrong."
              required
              error={fieldErrors.preferredTimezone}
            >
              <Select
                id="lead-call-zone"
                value={callZone}
                onChange={(event) => setCallZone(event.target.value)}
                invalid={Boolean(fieldErrors.preferredTimezone)}
              >
                <option value="">Select a time zone…</option>
                {ZONE_OPTIONS.map((zone) => (
                  <option key={zone} value={zone}>
                    {zoneLabel(zone)}
                  </option>
                ))}
              </Select>
            </Field>

            {callAt !== "" && callZone !== "" && (
              <p className="text-sm text-ink-muted">
                We have you down for{" "}
                <span className="text-ink">
                  {new Date(callAt).toLocaleString("en-GB", {
                    dateStyle: "full",
                    timeStyle: "short",
                  })}
                </span>{" "}
                in {zoneLabel(callZone)}.
              </p>
            )}
          </div>
        </StepCard>
      )}

      {step === "scope" && (
        <StepCard
          title="How much support, and what budget?"
          hint="Rough is fine. It tells us who to put you with and what shape the engagement takes."
          onBack={goBack}
          onNext={goNext}
          nextDisabled={!scopeReady}
        >
          <div className="space-y-5">
            <Field
              id="lead-engagement"
              label="How long are you looking for support?"
              required
              error={fieldErrors.engagementCount ?? fieldErrors.engagementUnit}
            >
              <div className="grid grid-cols-2 gap-3">
                <Select
                  id="lead-engagement"
                  aria-label="How many"
                  value={engagementCount}
                  onChange={(event) => setEngagementCount(event.target.value)}
                  invalid={Boolean(fieldErrors.engagementCount)}
                >
                  <option value="">How many…</option>
                  {Array.from({ length: 10 }, (_, n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
                <Select
                  aria-label="Weeks, months or years"
                  value={engagementUnit}
                  onChange={(event) => setEngagementUnit(event.target.value)}
                  invalid={Boolean(fieldErrors.engagementUnit)}
                >
                  <option value="">Period…</option>
                  <option value="WEEK">{engagementCount === "1" ? "Week" : "Weeks"}</option>
                  <option value="MONTH">{engagementCount === "1" ? "Month" : "Months"}</option>
                  <option value="YEAR">{engagementCount === "1" ? "Year" : "Years"}</option>
                </Select>
              </div>
            </Field>

            <Field
              id="lead-budget"
              label="What is your estimated budget?"
              hint="In US dollars. An estimate is genuinely useful — it is not a commitment."
              required
              error={fieldErrors.budgetAmount ?? fieldErrors.budgetBasis}
            >
              <div className="grid grid-cols-[10rem_1fr] gap-3">
                <Select
                  aria-label="Per hour or per month"
                  value={budgetBasis}
                  onChange={(event) => setBudgetBasis(event.target.value)}
                >
                  <option value="MONTHLY">Per month</option>
                  <option value="HOURLY">Per hour</option>
                </Select>
                <div className="relative">
                  <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-ink-subtle">
                    $
                  </span>
                  <Input
                    id="lead-budget"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    value={budgetAmount}
                    placeholder={budgetBasis === "HOURLY" ? "75.00" : "4000.00"}
                    onChange={(event) => setBudgetAmount(event.target.value)}
                    invalid={Boolean(fieldErrors.budgetAmount)}
                    className="pl-7"
                  />
                </div>
              </div>
            </Field>

            {/*
              Recorded as its own field rather than inferred from a round number.
              Whether someone *volunteered* that a figure is movable is a
              different signal from whether it happens to be movable, and the
              first is the one worth having before a call.
            */}
            <Checkbox
              id="lead-negotiable"
              checked={budgetNegotiable}
              onChange={(event) => setBudgetNegotiable(event.target.checked)}
              label="This is negotiable"
            />
          </div>
        </StepCard>
      )}

      {step === "certification" && (
        <StepCard
          title="Which certification are you working towards?"
          hint="Salesforce's own catalogue, grouped by track. Pick the last option if you have not decided."
          onBack={goBack}
          onNext={goNext}
          nextDisabled={!certificationReady}
        >
          <Field
            id="lead-certification"
            label="Certification"
            hint="The exam you are preparing for."
            required
            error={fieldErrors.certification}
          >
            {/*
              Grouped by track rather than one flat list of forty-eight. Almost
              nobody browses this — they arrive knowing "something Developer" or
              "something Architect" — and the headings turn a scan of the whole
              list into a scan of one section.

              A native select, so the phone picker and the keyboard type-ahead
              are the ones people already know. Worth revisiting if the list
              grows enough to need a search box.
            */}
            <Select
              id="lead-certification"
              value={certification}
              onChange={(event) => {
                setCertification(event.target.value);
              }}
              invalid={Boolean(fieldErrors.certification)}
            >
              <option value="">Select a certification…</option>
              {CERTIFICATION_TRACKS.map((group) => (
                <optgroup key={group.track} label={group.track}>
                  {group.certifications.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </optgroup>
              ))}
              <option value={CERTIFICATION_UNDECIDED}>{CERTIFICATION_UNDECIDED}</option>
            </Select>
          </Field>
        </StepCard>
      )}

      {step === "details" && (
        <StepCard
          title="How can we reach you?"
          hint="We'll use this to get back to you — usually the same working day."
          onBack={goBack}
          onNext={goNext}
          nextLabel="Review"
          nextDisabled={!detailsReady}
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
        </StepCard>
      )}

      {step === "review" && (
        <StepCard
          title="Does this look right?"
          hint="Check it over before we send it. Nothing is charged."
          onBack={goBack}
          onNext={() => void submit()}
          nextLoading={submitting}
          nextLabel={submitting ? "Sending…" : "Send my request"}
          nextDisabled={submitting}
        >
          <dl className="divide-y divide-border">
            <Row label="Name" onEdit={() => setStep("details")}>
              {name.trim()}
            </Row>
            <Row label="Email" onEdit={() => setStep("details")}>
              {email.trim()}
            </Row>
            <Row label="Phone" onEdit={() => setStep("details")}>
              {phone.trim()}
            </Row>
            <Row label="Type" onEdit={() => setStep("kind")}>
              {longTerm ? "Long-term support" : "Instant support"}
            </Row>
            {longTerm && (
              <>
                {/* The title lives on the describe step now, so Edit goes there. */}
                <Row label="Title" onEdit={() => setStep("describe")}>
                  {title.trim()}
                </Row>
                <Row label="For how long" onEdit={() => setStep("scope")}>
                  {engagementCount} {UNIT_LABELS[engagementUnit] ?? ""}
                </Row>
                <Row label="Budget" onEdit={() => setStep("scope")}>
                  ${budgetAmount} {budgetBasis === "HOURLY" ? "per hour" : "per month"}
                  {budgetNegotiable && <span className="text-ink-muted"> · negotiable</span>}
                </Row>
              </>
            )}
            {certifying && (
              <>
                <Row label="Certification" onEdit={() => setStep("certification")}>
                  {certification}
                </Row>
                <Row label="Exam date" onEdit={() => setStep("describe")}>
                  {examDate === ""
                    ? "Not booked yet"
                    : new Date(`${examDate}T00:00:00`).toLocaleDateString("en-GB", {
                        dateStyle: "full",
                      })}
                </Row>
                <Row label="Help needed" onEdit={() => setStep("describe")}>
                  {helpNeeded.join(", ")}
                </Row>
              </>
            )}

            {scheduled && (
              <Row label="Call at" onEdit={() => setStep("when")}>
                {callAt === ""
                  ? "Not chosen"
                  : `${new Date(callAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })} · ${zoneLabel(callZone)}`}
              </Row>
            )}
            {!longTerm && (
              <Row label="Session" onEdit={() => setStep("duration")}>
                {tier
                  ? `${String(tier.durationMinutes)} minutes · ${formatMoney(tier.priceCents, tier.currency)}`
                  : "Not chosen"}
              </Row>
            )}
            <Row label="Your problem" onEdit={() => setStep("describe")}>
              {/*
                Shown whole rather than truncated. This is the last chance to
                catch something that should not have been typed into a public
                box, and a customer cannot check text they cannot see.
              */}
              <span className="block whitespace-pre-wrap">{trimmed}</span>
            </Row>
          </dl>

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

/**
 * One reviewed value, with its own way back to the step that owns it.
 *
 * Per-row rather than a single "Edit" for the whole summary: someone who spots a
 * typo in their phone number should land on the field with the typo, not at the
 * start of a form they have already filled in.
 */
function Row({
  label,
  onEdit,
  children,
}: {
  label: string;
  onEdit: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr_auto] items-start gap-3 py-3">
      <dt className="eyebrow pt-0.5 text-ink-subtle">{label}</dt>
      <dd className="min-w-0 text-sm leading-relaxed text-ink">{children}</dd>
      <button
        type="button"
        onClick={onEdit}
        className="interactive rounded-sm text-xs font-medium text-accent hover:underline"
      >
        Edit
      </button>
    </div>
  );
}
