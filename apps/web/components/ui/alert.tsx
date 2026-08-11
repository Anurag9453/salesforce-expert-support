import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type Tone = "info" | "success" | "warning" | "danger";

const TONES: Record<Tone, string> = {
  info: "border-accent/25 bg-accent-subtle text-accent",
  success: "border-available/25 bg-available-subtle text-available",
  warning: "border-warning/25 bg-warning-subtle text-warning",
  danger: "border-danger/25 bg-danger-subtle text-danger",
};

/** The 2px leading edge, so tone is legible before the copy is read. */
const LEADING: Record<Tone, string> = {
  info: "border-l-accent",
  success: "border-l-available",
  warning: "border-l-warning",
  danger: "border-l-danger",
};

export function Alert({
  tone = "info",
  title,
  children,
  className,
}: {
  tone?: Tone;
  title?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "animate-scale-in rounded-lg border border-l-2 px-4 py-3 text-sm shadow-flat",
        TONES[tone],
        LEADING[tone],
        className,
      )}
    >
      {title && <p className="font-medium">{title}</p>}
      {children && <div className={cn(title && "mt-1", "text-ink-muted")}>{children}</div>}
    </div>
  );
}
