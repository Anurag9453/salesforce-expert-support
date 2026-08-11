import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        "h-10 w-full rounded-md px-3 text-sm",
        "border bg-surface-raised text-ink shadow-sunken",
        "placeholder:text-ink-subtle",
        "transition-[border-color,box-shadow] duration-150 ease-[cubic-bezier(0.16,1,0.3,1)]",
        "focus:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-ring",
        "hover:border-border-strong/80",
        "disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-ink-subtle",
        invalid ? "border-danger" : "border-border-strong",
        className,
      )}
      {...props}
    />
  );
});
