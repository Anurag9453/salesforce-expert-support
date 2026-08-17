import { forwardRef, type SelectHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * A native select, styled to match `Input`.
 *
 * Native rather than a custom listbox, deliberately. A hand-built dropdown has to
 * re-implement keyboard navigation, type-ahead, screen-reader semantics and the
 * mobile picker, and gets at least one of them wrong. The only thing lost is
 * control over the option list's appearance, which is not worth any of that.
 *
 * The class list is shared with the country/timezone picker, which grew the same
 * styling locally first — this is that string extracted rather than a third
 * variant of it.
 */
export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, invalid, ...props },
  ref,
) {
  return (
    <select
      ref={ref}
      aria-invalid={invalid ? true : undefined}
      className={cn(
        "h-10 w-full rounded-md border border-border-strong bg-surface-raised px-3 text-sm text-ink shadow-sunken",
        "transition-[border-color,box-shadow] duration-150",
        "hover:border-accent/40",
        "focus:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-ring",
        "disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-ink-subtle",
        invalid && "border-danger",
        className,
      )}
      {...props}
    />
  );
});
