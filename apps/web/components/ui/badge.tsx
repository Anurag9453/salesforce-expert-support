import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type Tone = "neutral" | "accent" | "available" | "warning" | "danger";

const TONES: Record<Tone, string> = {
  neutral: "border-border bg-surface-sunken text-ink-muted",
  accent: "border-accent/20 bg-accent-subtle text-accent",
  available: "border-available/25 bg-available-subtle text-available",
  warning: "border-warning/25 bg-warning-subtle text-warning",
  danger: "border-danger/25 bg-danger-subtle text-danger",
};

const DOTS: Record<Tone, string> = {
  neutral: "bg-ink-subtle",
  accent: "bg-accent",
  available: "bg-available",
  warning: "bg-warning",
  danger: "bg-danger",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  /** Leading status dot. `pulse` adds an expanding ring for live states only. */
  dot?: boolean;
  pulse?: boolean;
}

export function Badge({ className, tone = "neutral", dot, pulse, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium",
        TONES[tone],
        className,
      )}
      {...props}
    >
      {(dot ?? pulse) && (
        <span className="relative flex size-1.5 shrink-0" aria-hidden="true">
          {/*
            Decoration only. The badge's own text says what the state is, so a
            user with reduced motion — where the animation is collapsed — loses
            nothing but the flourish.
          */}
          {pulse && (
            <span className={cn("absolute inset-0 animate-pulse-ring rounded-full", DOTS[tone])} />
          )}
          <span className={cn("relative size-1.5 rounded-full", DOTS[tone])} />
        </span>
      )}
      {children}
    </span>
  );
}
