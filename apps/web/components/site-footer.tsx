import Link from "next/link";

/**
 * The footer every public page shares.
 *
 * Extracted from the landing page, which had it inline. A footer that exists on
 * one page is not a footer — it is decoration on that page, and the pages a
 * visitor actually goes looking for (what is this, who runs it, what happens to
 * my data) have no way of being found.
 *
 * The safety notice stays here rather than moving to Terms alone. Somebody about
 * to paste a stack trace containing a session id is not reading Terms; they are
 * looking at a form. It has to be where they are.
 */

const SECTIONS: ReadonlyArray<{
  heading: string;
  links: ReadonlyArray<{ href: string; label: string }>;
}> = [
  {
    heading: "Product",
    links: [
      { href: "/request-help", label: "Get a Salesforce expert" },
      { href: "/expert-application", label: "Become an expert" },
      { href: "/login", label: "Expert sign in" },
    ],
  },
  {
    heading: "Company",
    links: [
      { href: "/about", label: "About" },
      { href: "/contact", label: "Contact" },
    ],
  },
  {
    heading: "Legal",
    links: [
      { href: "/privacy", label: "Privacy" },
      { href: "/terms", label: "Terms" },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-border bg-surface-raised">
      <div className="mx-auto max-w-5xl px-6 py-12">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="font-display text-sm font-medium text-ink">Salesforce Expert Support</p>
            <p className="mt-2 max-w-xs text-xs leading-relaxed text-ink-subtle">
              Describe a Salesforce problem once. We put it in front of someone who has already
              solved it.
            </p>
          </div>

          {SECTIONS.map((section) => (
            <nav key={section.heading} aria-label={section.heading}>
              <p className="eyebrow text-ink-subtle">{section.heading}</p>
              <ul className="mt-3 space-y-2">
                {section.links.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="text-xs text-ink-muted transition-colors hover:text-accent"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-10 flex flex-col gap-4 border-t border-border pt-6 sm:flex-row sm:items-start sm:justify-between">
          {/*
            Kept in the footer of every page, not tucked into Terms. Somebody
            about to paste a stack trace with a session id in it is looking at a
            form, not at a legal page.
          */}
          <p className="max-w-lg text-xs leading-relaxed text-ink-subtle">
            Never share passwords, access tokens, private keys, or production customer data through
            this platform. Health Cloud technical support is in scope; actual patient data is not.
          </p>
          <p className="text-xs whitespace-nowrap text-ink-subtle">
            © {String(new Date().getFullYear())} Salesforce Expert Support
          </p>
        </div>

        <p className="mt-6 text-[0.6875rem] leading-relaxed text-ink-subtle">
          Not affiliated with, endorsed by, or sponsored by Salesforce, Inc.
          &ldquo;Salesforce&rdquo; and related marks are trademarks of Salesforce, Inc., used here
          only to describe the expertise on offer.
        </p>
      </div>
    </footer>
  );
}
