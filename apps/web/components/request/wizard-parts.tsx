"use client";

import type React from "react";
import { Button, Card, CardBody } from "@/components/ui";
import { cn } from "@/lib/utils";

export function Progress({
  index,
  labels,
  onSelect,
}: {
  index: number;
  labels: readonly string[];
  onSelect?: (index: number) => void;
}) {
  return (
    <ol className="flex items-start" aria-label="Progress">
      {labels.map((label, position) => {
        const done = position < index;
        const current = position === index;
        const last = position === labels.length - 1;
        const clickable = done && onSelect !== undefined;

        const marker = (
          <span
            className={cn(
              "grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold",
              current && "bg-accent text-ink-inverse shadow-accent",
              done && "bg-accent text-ink-inverse",
              !current && !done && "border border-border bg-surface-sunken text-ink-subtle",
            )}
          >
            {done ? (
              <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden="true">
                <path fill="currentColor" d="M6.2 10.6 3.8 8.2l-.9.9 3.3 3.3 7-7-.9-.9z" />
              </svg>
            ) : (
              position + 1
            )}
          </span>
        );

        return (
          <li key={label} className="flex min-w-0 items-start last:flex-none not-last:flex-1">
            <div className="flex w-14 shrink-0 flex-col items-center sm:w-16">
              {clickable ? (
                <button
                  type="button"
                  onClick={() => onSelect(position)}
                  className="flex flex-col items-center gap-1.5"
                >
                  {marker}
                  <span
                    className={cn(
                      "text-center text-[0.6875rem] leading-tight font-medium",
                      "text-ink",
                    )}
                  >
                    {label}
                  </span>
                </button>
              ) : (
                <div className="flex flex-col items-center gap-1.5">
                  {marker}
                  <span
                    className={cn(
                      "text-center text-[0.6875rem] leading-tight font-medium",
                      current ? "text-ink" : "text-ink-subtle",
                    )}
                  >
                    {label}
                  </span>
                </div>
              )}
            </div>
            {last ? null : (
              <span
                aria-hidden="true"
                className={cn(
                  "mt-3.5 mx-0.5 h-px min-w-1 flex-1 self-start rounded-full sm:mx-1",
                  done || current ? "bg-accent/40" : "bg-border",
                )}
              />
            )}
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
  nextLabel = "Continue",
  nextDisabled,
  nextLoading,
  framed = true,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  onBack: () => void;
  onNext: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  nextLoading?: boolean;
  framed?: boolean;
}) {
  const body = (
    <>
      <h2 className="font-display text-xl font-medium text-ink">{title}</h2>
      {hint ? <p className="mt-1 text-sm text-ink-muted">{hint}</p> : null}
      <div className="mt-5">{children}</div>
      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <Button size="sm" onClick={onNext} loading={nextLoading} disabled={nextDisabled}>
          {nextLabel}
        </Button>
        <Button size="sm" variant="ghost" onClick={onBack} disabled={nextLoading}>
          Back
        </Button>
      </div>
    </>
  );

  if (!framed) return <div className="animate-rise-in">{body}</div>;

  return (
    <Card accent className="animate-rise-in">
      <CardBody className="p-6">{body}</CardBody>
    </Card>
  );
}

export { ChoiceCard } from "@/components/ui";
