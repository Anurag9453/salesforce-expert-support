import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Label + control + error, wired together.
 *
 * A field component rather than a bare Label so `htmlFor`, `aria-describedby`
 * and the error region cannot drift apart — accessibility is a Phase 11 gate
 * and retrofitting it across every form is far more expensive than this.
 */
export function Field({
  id,
  label,
  hint,
  error,
  required,
  children,
  className,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string[] | undefined;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error?.length ? `${id}-error` : undefined;

  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
        {required && (
          <span className="ml-1 text-danger" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {hint && (
        <p id={hintId} className="text-xs text-ink-subtle">
          {hint}
        </p>
      )}
      {children}
      {error?.length ? (
        <p id={errorId} role="alert" className="text-xs text-danger">
          {error.join(" ")}
        </p>
      ) : null}
    </div>
  );
}

export function describedBy(id: string, hint?: string, error?: string[]): string | undefined {
  const ids = [hint ? `${id}-hint` : null, error?.length ? `${id}-error` : null].filter(Boolean);
  return ids.length > 0 ? ids.join(" ") : undefined;
}
