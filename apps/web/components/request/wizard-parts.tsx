"use client";

import type React from "react";
import { Button, Card, CardBody } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * The presentational pieces both intakes share.
 *
 * Extracted when the lead-capture form arrived: two wizards that look different
 * from each other is a worse outcome than one shared step chrome, and the parts
 * carry no behaviour worth duplicating.
 */

export function Progress({ index, labels }: { index: number; labels: readonly string[] }) {
  return (
    <ol className="flex items-center gap-2" aria-label="Progress">
      {labels.map((label, position) => {
        const done = position < index;
        const current = position === index;
        return (
          <li key={label} className="flex flex-1 items-center gap-2">
            <div className="min-w-0 flex-1">
              <span
                className={cn(
                  "block text-[0.6875rem] font-medium tracking-wide uppercase",
                  current ? "text-accent" : done ? "text-ink-muted" : "text-ink-subtle",
                )}
              >
                {label}
              </span>
              <span
                aria-hidden="true"
                className={cn(
                  "mt-1 block h-0.5 rounded-full transition-colors duration-300",
                  current || done ? "bg-accent" : "bg-border",
                )}
              />
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function StepCard({
  title,
  hint,
  children,
  onBack,
  onNext,
  nextLabel = "Next",
  nextDisabled,
  nextLoading,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  onBack: () => void;
  onNext: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  /**
   * The last step submits, and that is a network round trip on a public form.
   * Separate from `nextDisabled`, which means "you have not filled this in yet" —
   * the two look the same to CSS and mean opposite things to a person.
   */
  nextLoading?: boolean;
}) {
  return (
    <Card accent className="animate-rise-in">
      <CardBody className="p-6">
        <h2 className="font-display text-xl font-medium text-ink">{title}</h2>
        {hint && <p className="mt-1 text-sm text-ink-muted">{hint}</p>}
        <div className="mt-5">{children}</div>
        <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-border pt-5">
          <Button size="lg" onClick={onNext} loading={nextLoading} disabled={nextDisabled}>
            {nextLabel}
          </Button>
          <Button variant="ghost" onClick={onBack} disabled={nextLoading}>
            Back
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

/*
  ChoiceCard moved to components/ui, because the landing page needs the same card
  and had grown its own near-copy. Re-exported here so the wizards' imports keep
  reading as one list of local parts.
*/
export { ChoiceCard } from "@/components/ui";
