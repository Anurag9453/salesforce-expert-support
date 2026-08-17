import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * `interactive` makes a card lift only when `interactive` is asked for. A card
 * that lifts without being clickable is a lie about affordance, so the hover
 * treatment is opt-in rather than the default.
 *
 * `accent` draws a hairline rule along the top edge — used for the one card on
 * a page that matters most (a live request, an open offer).
 */
export function Card({
  className,
  interactive,
  accent,
  ...props
}: HTMLAttributes<HTMLDivElement> & { interactive?: boolean; accent?: boolean }) {
  return (
    <div
      className={cn(
        // `edge-lit` adds the one-pixel highlight along the top edge that reads as
        // light catching a real surface. Barely visible alone; across a grid it
        // is most of the difference between flat and dimensional.
        "edge-lit relative rounded-xl border border-border bg-surface-raised",
        accent &&
          cn(
            "before:absolute before:inset-x-0 before:top-0 before:h-px",
            "before:bg-linear-to-r before:from-transparent before:via-accent/50 before:to-transparent",
          ),
        interactive &&
          "interactive hover:-translate-y-0.5 hover:border-accent/30 hover:shadow-lifted",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex items-center gap-3 border-b border-border px-5 py-3.5", className)}
      {...props}
    />
  );
}

/**
 * Sentence case, not the uppercase micro-label a dashboard usually reaches for:
 * these titles range from "Skills" to "Your expert application", and uppercase
 * turns the longer ones into shouting.
 */
export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3 className={cn("text-sm font-semibold tracking-tight text-ink", className)} {...props} />
  );
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 py-4", className)} {...props} />;
}

/** Right-aligned action row, so cards that end in buttons all end the same way. */
export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-3 border-t border-border bg-surface-sunken/50 px-5 py-3",
        className,
      )}
      {...props}
    />
  );
}
