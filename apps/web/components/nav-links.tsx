"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export interface NavLink {
  href: string;
  label: string;
}

/**
 * The nav, split out as a client component purely so it can read the pathname
 * and mark the current section. The link list itself is still computed on the
 * server from the actor's permissions — this component receives it and never
 * decides what a user may see.
 *
 * `aria-current` is the real signal; the underline is decoration on top of it.
 */
export function NavLinks({ links }: { links: readonly NavLink[] }) {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-1" aria-label="Main">
      {links.map((link) => {
        // `/expert` must not light up while you are on `/expert-application`.
        const active = pathname === link.href || pathname.startsWith(`${link.href}/`);

        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "interactive relative rounded-md px-2.5 py-1.5 text-sm",
              active ? "text-ink" : "text-ink-muted hover:bg-surface-sunken hover:text-ink",
            )}
          >
            {link.label}
            {active && (
              <span
                aria-hidden="true"
                className="absolute inset-x-2.5 -bottom-px h-0.5 animate-slide-in rounded-full bg-accent"
              />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
