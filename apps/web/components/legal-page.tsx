import type { ReactNode } from "react";
import { Alert, Badge } from "@/components/ui";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

/**
 * The shell for Privacy and Terms.
 *
 * ## Why the draft notice is on the page and not just in a code comment
 *
 * Neither document has been reviewed by a lawyer, and both contain placeholders
 * where a company name and address belong. A privacy notice that reads as
 * finished but is not is worse than an obviously unfinished one: a visitor is
 * entitled to know whether what they are reading is a commitment or a sketch, and
 * so is anyone assessing the business later.
 *
 * The banner is meant to be deleted — by whoever gets these reviewed, at the same
 * time they fill in the placeholders. Until then it is the honest state of things
 * rather than an apology for it.
 */
export function LegalPage({
  kind,
  title,
  summary,
  updated,
  children,
}: {
  kind: string;
  title: string;
  summary: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <main className="min-h-dvh">
      <SiteHeader />

      <div className="mx-auto max-w-3xl px-6 py-14">
        <Badge>{kind}</Badge>
        <h1 className="font-display mt-4 text-3xl leading-tight font-medium text-balance text-ink">
          {title}
        </h1>
        <p className="mt-4 text-sm leading-relaxed text-ink-muted">{summary}</p>
        <p className="mt-2 text-xs text-ink-subtle">Last updated {updated}</p>

        <Alert tone="warning" className="mt-8" title="Draft — not yet reviewed">
          This document has not been reviewed by a lawyer and contains placeholders in square
          brackets where a legal entity, address and jurisdiction belong. Treat it as a statement of
          intent rather than a binding one, and tell us if anything here concerns you.
        </Alert>

        <div className="mt-10 space-y-10">{children}</div>
      </div>

      <SiteFooter />
    </main>
  );
}

/** One numbered section. Headings are `h2` so the page outlines correctly. */
export function LegalSection({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="font-display text-xl font-medium text-ink">{heading}</h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-ink-muted">{children}</div>
    </section>
  );
}
