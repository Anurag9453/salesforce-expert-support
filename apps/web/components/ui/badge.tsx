import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type Tone = "neutral" | "accent" | "available" | "warning" | "danger";

const TONES: Record<Tone, string> = {
  neutral: "bg-surface-sunken text-ink-muted border-border",
  accent: "bg-accent-subtle text-accent border-accent/20",
  available: "bg-available-subtle text-available border-available/25",
  warning: "bg-warning-subtle text-warning border-warning/25",
  danger: "bg-danger-subtle text-danger border-danger/25",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
}

export function Badge({ className, tone = "neutral", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border px-2 py-0.5 text-xs font-medium",
        TONES[tone],
        className,
      )}
      {...props}
    />
  );
}
