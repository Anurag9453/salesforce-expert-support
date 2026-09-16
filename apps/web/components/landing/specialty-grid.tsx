import Link from "next/link";
import { SPECIALTIES } from "@/lib/specialties";

export function SpecialtyGrid({
  title = "Choose a specialty",
  description = "Each option opens a request for that practice area, with its own skills.",
}: {
  title?: string;
  description?: string;
}) {
  return (
    <div>
      <h2 className="font-display text-xl font-medium text-ink">{title}</h2>
      {description ? <p className="mt-1 text-sm text-ink-muted">{description}</p> : null}
      <ul className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {SPECIALTIES.map((item) => (
          <li key={item.name}>
            <Link
              href={item.href}
              className="interactive flex h-full items-center justify-between gap-3 rounded-lg border border-border bg-surface-raised px-4 py-3 hover:border-accent/30"
            >
              <span>
                <span className="block text-sm font-semibold text-ink">{item.name}</span>
                <span className="mt-0.5 block text-xs text-ink-muted">{item.skills}</span>
              </span>
              <span className="text-xs font-medium text-accent">Hire</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
