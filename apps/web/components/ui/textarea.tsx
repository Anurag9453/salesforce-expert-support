import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        "w-full rounded-md border bg-surface-raised px-3 py-2 text-sm text-ink",
        "placeholder:text-ink-subtle",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring",
        "disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-ink-subtle",
        invalid ? "border-danger" : "border-border-strong",
        className,
      )}
      {...props}
    />
  );
});
