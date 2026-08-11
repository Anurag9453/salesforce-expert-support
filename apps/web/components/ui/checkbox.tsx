import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: string;
  description?: string;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { className, label, description, id, ...props },
  ref,
) {
  return (
    <div
      className={cn(
        "interactive flex gap-2.5 rounded-md border border-transparent p-2 -m-2",
        "hover:border-border hover:bg-surface-sunken/60",
        "has-[:checked]:border-accent/25 has-[:checked]:bg-accent-subtle/50",
      )}
    >
      <input
        ref={ref}
        id={id}
        type="checkbox"
        className={cn(
          "mt-0.5 size-4 shrink-0 cursor-pointer rounded-sm border-border-strong text-accent",
          "accent-[var(--color-accent)]",
          "focus-visible:ring-2 focus-visible:ring-accent-ring",
          className,
        )}
        aria-describedby={description ? `${id}-description` : undefined}
        {...props}
      />
      <div className="space-y-0.5">
        <label htmlFor={id} className="block cursor-pointer text-sm text-ink">
          {label}
        </label>
        {description && (
          <p id={`${id}-description`} className="text-xs text-ink-subtle">
            {description}
          </p>
        )}
      </div>
    </div>
  );
});
