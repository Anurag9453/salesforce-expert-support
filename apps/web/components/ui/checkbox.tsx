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
    <div className="flex gap-2.5">
      <input
        ref={ref}
        id={id}
        type="checkbox"
        className={cn(
          "mt-0.5 size-4 shrink-0 rounded-sm border-border-strong text-accent",
          "focus-visible:ring-2 focus-visible:ring-accent-ring",
          className,
        )}
        aria-describedby={description ? `${id}-description` : undefined}
        {...props}
      />
      <div className="space-y-0.5">
        <label htmlFor={id} className="block text-sm text-ink">
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
