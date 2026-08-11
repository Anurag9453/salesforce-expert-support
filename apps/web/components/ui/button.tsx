import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

/**
 * Primary carries a shallow two-stop gradient and a coloured shadow, which is
 * what separates "the button you press" from "a blue rectangle". Shallow on
 * purpose — a strong gradient reads as a consumer app.
 */
const VARIANTS: Record<Variant, string> = {
  primary: cn(
    "bg-linear-to-b from-accent to-accent-hover text-ink-inverse shadow-accent",
    "hover:-translate-y-px hover:brightness-110",
    "disabled:from-ink-subtle disabled:to-ink-subtle disabled:shadow-none",
  ),
  secondary: cn(
    "border border-border-strong bg-surface-raised text-ink shadow-flat",
    "hover:-translate-y-px hover:border-accent/40 hover:shadow-raised",
  ),
  ghost: "text-ink-muted hover:bg-surface-sunken hover:text-ink",
  danger: "bg-danger text-ink-inverse hover:-translate-y-px hover:brightness-110",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 gap-1.5 px-3 text-sm",
  md: "h-10 gap-2 px-4 text-sm",
  lg: "h-12 gap-2 px-6 text-[0.9375rem]",
};

/**
 * The shared recipe, exported so a `<Link>` can look like a button without an
 * `asChild` polymorphism layer. Something that navigates should stay an anchor:
 * that is the element that gets keyboard and middle-click behaviour for free.
 */
export function buttonClasses(
  options: { variant?: Variant; size?: Size; className?: string } = {},
): string {
  const { variant = "primary", size = "md", className } = options;
  return cn(
    "interactive inline-flex items-center justify-center rounded-md font-medium select-none",
    "whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-60",
    // Cancels the hover lift, so a disabled control never feels pressable.
    "disabled:translate-y-0 disabled:brightness-100",
    VARIANTS[variant],
    SIZES[size],
    className,
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "primary", size = "md", type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClasses({ variant, size, ...(className ? { className } : {}) })}
      {...props}
    />
  );
});
