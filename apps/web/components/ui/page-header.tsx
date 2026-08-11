import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Every page had its own hand-rolled `<header>` with a slightly different title
 * size and margin. One component instead, so the display face, the flourish and
 * the spacing rhythm cannot drift page to page.
 *
 * `eyebrow` is the small label above the title; `actions` sits on the trailing
 * edge and wraps beneath the title on narrow screens.
 */
export function PageHeader({
  title,
  eyebrow,
  description,
  actions,
  meta,
  back,
  flourish = true,
  className,
}: {
  title: string;
  eyebrow?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Badges or status chips, shown under the title. */
  meta?: ReactNode;
  /** Breadcrumb back to the parent screen. Replaces the eyebrow when present. */
  back?: { href: string; label: string };
  flourish?: boolean;
  className?: string;
}) {
  return (
    <header className={cn("animate-rise-in", className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="min-w-0 flex-1">
          {back && (
            <Link
              href={back.href}
              className="interactive group mb-2 inline-flex items-center gap-1.5 text-xs text-ink-muted hover:text-accent"
            >
              <span
                aria-hidden="true"
                className="transition-transform duration-200 group-hover:-translate-x-0.5"
              >
                ←
              </span>
              {back.label}
            </Link>
          )}
          {eyebrow && !back && (
            <p className="mb-2 text-xs font-medium tracking-[0.08em] text-ink-subtle uppercase">
              {eyebrow}
            </p>
          )}
          <h1 className="font-display text-3xl leading-[1.15] font-medium text-balance text-ink">
            {title}
          </h1>
          {flourish && <Flourish />}
          {description && (
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-muted">{description}</p>
          )}
          {meta && <div className="mt-3 flex flex-wrap items-center gap-2">{meta}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2.5">{actions}</div>}
      </div>
    </header>
  );
}

/**
 * The calligraphic detail: a single pen-stroke rule that draws itself in once.
 * An SVG path rather than a border, because a border cannot taper — and the
 * taper is the entire reason it reads as a stroke rather than a line.
 */
function Flourish() {
  return (
    <svg
      className="mt-2 h-2 w-28 text-accent/45"
      viewBox="0 0 120 8"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        className="animate-draw"
        d="M1 5.5C18 2.2 34 1.4 52 3.1c18 1.7 34 3.4 67 1.2"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        pathLength={1}
        strokeDasharray={1}
      />
    </svg>
  );
}

/**
 * A labelled figure. Used where a page reports a handful of numbers — the
 * admin dispatch view, expert earnings — so they line up and share one style.
 */
export function Stat({
  label,
  value,
  hint,
  tone = "ink",
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: "ink" | "accent" | "available" | "warning" | "danger";
}) {
  const TONE = {
    ink: "text-ink",
    accent: "text-accent",
    available: "text-available",
    warning: "text-warning",
    danger: "text-danger",
  } as const;

  return (
    <div className="min-w-0">
      <p className="text-xs font-medium tracking-wide text-ink-subtle uppercase">{label}</p>
      <p
        data-numeric
        className={cn("font-display mt-1 text-2xl leading-none font-medium", TONE[tone])}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-ink-subtle">{hint}</p>}
    </div>
  );
}
