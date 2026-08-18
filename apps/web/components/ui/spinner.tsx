import { cn } from "@/lib/utils";

/**
 * A spinner, for the moments the app cannot answer instantly.
 *
 * Drawn with a border rather than an SVG or a GIF: two lines of CSS, no request,
 * no layout shift, and it inherits `currentColor` so it is legible on a primary
 * button and on a page background without a variant for each.
 *
 * `aria-hidden`, deliberately. A spinning circle means nothing to a screen
 * reader, and announcing it is noise. Whatever *owns* the wait — a button, a
 * route — is responsible for saying so, which is why `Button` sets `aria-busy`
 * and the route-level fallbacks carry a live region.
 */
export function Spinner({
  size = "md",
  className,
}: {
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const dimensions = {
    sm: "size-3.5 border-[1.5px]",
    md: "size-5 border-2",
    lg: "size-8 border-2",
  }[size];

  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block animate-spin rounded-full align-[-0.125em]",
        // Three sides in the current colour, one transparent — that gap is the
        // only reason the rotation is visible on a plain ring.
        "border-current border-t-transparent",
        // Slower than the browser default, which reads as frantic on a page that
        // is merely fetching a few rows.
        "[animation-duration:0.7s]",
        dimensions,
        className,
      )}
    />
  );
}

/**
 * A spinner with a line of text, centred in whatever space it is given.
 *
 * The shared body of every route-level `loading.tsx`. `role="status"` with a
 * polite live region so the wait is announced once, rather than each route
 * inventing its own way to say the same thing.
 */
export function LoadingState({
  label = "Loading…",
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn("flex min-h-[40vh] flex-col items-center justify-center gap-3", className)}
    >
      <Spinner size="lg" className="text-accent" />
      <p className="text-sm text-ink-muted">{label}</p>
    </div>
  );
}
