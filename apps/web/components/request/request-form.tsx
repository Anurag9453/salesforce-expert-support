"use client";

import type { PricingTierView, TaxonomyCategory } from "@sfx/contracts";
import { MIN_DESCRIPTION_LENGTH } from "@sfx/contracts";
import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { Alert, Button, Textarea } from "@/components/ui";
import { AttachmentPicker, type PendingAttachment } from "./attachment-picker";
import { cn } from "@/lib/utils";

/**
 * "Get Expert Help" (§7, requirements 1–3).
 *
 * The shape of this form is the product decision. A customer with a broken org
 * is not in the mood for a questionnaire, and asking them to categorise their
 * own problem gets you a wrong category confidently asserted — worse than none.
 *
 * So: one textarea, one button. Everything else is behind "Add detail" and
 * genuinely optional. Category chips are labelled as a hint, never as a
 * required diagnosis (requirement 2), and the classifier plus the description
 * carry the real signal.
 *
 * The credential warning is a single calm line that is always visible rather
 * than a modal that has to be dismissed (requirement 5). If something is
 * actually detected, the server says so afterwards — specifically, and without
 * implying the customer did something wrong.
 */

const PLACEHOLDER = `Example: Our LWC on the Account page isn't refreshing after an imperative Apex call. We call refreshApex after the update but the wire never re-runs, so the user sees stale data until they reload.

What's the problem, what have you already tried, and what does "fixed" look like?`;

export function RequestForm({
  categories,
  tiers,
}: {
  categories: TaxonomyCategory[];
  tiers: PricingTierView[];
}) {
  const router = useRouter();

  const [description, setDescription] = useState("");
  const [showDetail, setShowDetail] = useState(false);
  const [categorySlug, setCategorySlug] = useState<string | null>(null);
  const [skillSlugs, setSkillSlugs] = useState<string[]>([]);
  const [tierId, setTierId] = useState(tiers[0]?.id ?? "");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = description.trim();
  const ready = trimmed.length >= MIN_DESCRIPTION_LENGTH && tierId !== "";

  // Skills are only offered once a category narrows them — 51 checkboxes is a
  // questionnaire, six chips is a hint.
  const skillsForCategory = useMemo(
    () => categories.find((c) => c.slug === categorySlug)?.skills ?? [],
    [categories, categorySlug],
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || submitting) return;

    setSubmitting(true);
    setError(null);

    const response = await fetch("/api/v1/requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        description: trimmed,
        pricingTierId: tierId,
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

    router.push(`/request/${body.data.request.id}`);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      {error && <Alert tone="danger">{error}</Alert>}

      <div className="space-y-2">
        <label htmlFor="description" className="block text-sm font-medium text-ink">
          What&rsquo;s going wrong?
        </label>
        <Textarea
          id="description"
          name="description"
          rows={9}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={PLACEHOLDER}
          className="text-[15px] leading-relaxed"
          autoFocus
          aria-describedby="description-hint credential-hint"
        />
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p id="description-hint" className="text-xs text-ink-subtle">
            Plain language is fine. Paste error messages and stack traces — they help.
          </p>
          {trimmed.length > 0 && trimmed.length < MIN_DESCRIPTION_LENGTH && (
            <p className="text-xs text-ink-subtle">
              A few more words ({MIN_DESCRIPTION_LENGTH - trimmed.length} to go)
            </p>
          )}
        </div>

        {/*
          Requirement 5: always present, one line, no icon, no colour alarm.
          It reads as guidance rather than as an accusation, and it does not
          block or interrupt anything.
        */}
        <p
          id="credential-hint"
          className="rounded-md border border-border bg-surface-sunken px-3 py-2 text-xs leading-relaxed text-ink-muted"
        >
          Please leave out passwords, tokens and production customer data — an expert never needs
          them. We check for them automatically and strip anything we spot.
        </p>
      </div>

      {/* Progressive disclosure (requirement 3): nothing below here is needed. */}
      {!showDetail ? (
        <button
          type="button"
          onClick={() => setShowDetail(true)}
          className="text-sm font-medium text-accent hover:underline"
        >
          + Add detail (optional)
        </button>
      ) : (
        <div className="space-y-5 rounded-lg border border-border bg-surface-sunken p-4">
          <div className="space-y-2">
            <p className="text-sm font-medium text-ink">Which area is this in?</p>
            {/* Requirement 2, said plainly to the customer. */}
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
                      "rounded-sm border px-2.5 py-1 text-xs transition-colors",
                      active
                        ? "border-accent/30 bg-accent-subtle font-medium text-accent"
                        : "border-border bg-surface-raised text-ink-muted hover:bg-surface-sunken",
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
                            ? current.filter((s) => s !== skill.slug)
                            : [...current, skill.slug],
                        )
                      }
                      className={cn(
                        "rounded-sm border px-2.5 py-1 text-xs transition-colors",
                        active
                          ? "border-accent/30 bg-accent-subtle font-medium text-accent"
                          : "border-border bg-surface-raised text-ink-muted hover:bg-surface-sunken",
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
      )}

      {tiers.length > 1 && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-ink">How long do you need?</legend>
          <div className="flex flex-wrap gap-2">
            {tiers.map((tier) => {
              const active = tierId === tier.id;
              return (
                <button
                  key={tier.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setTierId(tier.id)}
                  className={cn(
                    "rounded-md border px-3.5 py-2 text-left transition-colors",
                    active
                      ? "border-accent bg-accent-subtle"
                      : "border-border-strong bg-surface-raised hover:bg-surface-sunken",
                  )}
                >
                  <span className="block text-sm font-medium text-ink">
                    {tier.durationMinutes} minutes
                  </span>
                  <span className="block text-xs text-ink-subtle">
                    {formatPrice(tier.priceCents, tier.currency)}
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-5">
        <Button type="submit" size="lg" disabled={!ready || submitting}>
          {submitting ? "Finding an expert…" : "Get Expert Help"}
        </Button>
        <p className="text-xs text-ink-subtle">
          We&rsquo;ll match you with an expert in about 15 minutes. You&rsquo;re not charged unless
          the session happens.
        </p>
      </div>
    </form>
  );
}

function formatPrice(minor: number, currency: string): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(minor / 100);
}
