import { cn } from "@/lib/utils";

export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <span
        aria-hidden="true"
        className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent text-[0.7rem] font-semibold tracking-tight text-ink-inverse shadow-accent"
      >
        SX
      </span>
      <span className="font-display truncate text-[0.9375rem] font-semibold tracking-tight text-ink">
        Salesforce Expert
      </span>
    </span>
  );
}
