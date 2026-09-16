"use client";

import Link from "next/link";
import { useState } from "react";
import { BrandMark } from "./brand-mark";

const NAV = [
  { href: "/hire#skills", label: "Browse skills" },
  { href: "/hire#how-it-works", label: "How it works" },
] as const;

export function LandingHeader({ simple = false }: { simple?: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-surface-raised/90 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link href="/" className="min-w-0" aria-label="Salesforce Expert Support home">
          <BrandMark />
        </Link>

        {simple ? null : (
          <>
            <nav className="hidden items-center gap-8 md:flex" aria-label="Primary">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="text-sm font-medium text-ink-muted transition-colors hover:text-ink"
                >
                  {item.label}
                </Link>
              ))}
            </nav>

            <button
              type="button"
              className="inline-flex size-10 shrink-0 items-center justify-center rounded-md border border-border text-ink md:hidden"
              aria-expanded={open}
              aria-controls="landing-mobile-nav"
              onClick={() => setOpen((value) => !value)}
            >
              <span className="sr-only">{open ? "Close menu" : "Open menu"}</span>
              <span aria-hidden="true" className="flex flex-col gap-1.5">
                <span className="block h-0.5 w-5 bg-current" />
                <span className="block h-0.5 w-5 bg-current" />
                <span className="block h-0.5 w-4 bg-current" />
              </span>
            </button>
          </>
        )}
      </div>

      {!simple && open ? (
        <div id="landing-mobile-nav" className="border-t border-border px-6 py-4 md:hidden">
          <nav className="flex flex-col gap-3" aria-label="Mobile">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="py-1 text-sm font-medium text-ink"
                onClick={() => setOpen(false)}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      ) : null}
    </header>
  );
}
