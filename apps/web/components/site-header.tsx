import Link from "next/link";

/**
 * The header for public content pages — About, Contact, Privacy, Terms.
 *
 * Deliberately not used on the landing page, which opens with a full-bleed hero
 * and needs no bar above it, nor on the intake page, whose header shows a
 * dashboard link when an expert is signed in. This is the plain version: get
 * home, or ask for help.
 *
 * "Expert sign in" rather than "Sign in", for the same reason as everywhere else:
 * customers never need an account, and an unqualified sign-in link reads as a
 * step they have missed.
 */
export function SiteHeader() {
  return (
    <header className="border-b border-border bg-surface-raised/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-6">
        <Link
          href="/"
          className="font-display interactive text-[0.9375rem] font-medium tracking-tight text-ink hover:text-accent"
        >
          Salesforce Expert Support
        </Link>
        <div className="flex items-center gap-4">
          <Link href="/request-help" className="text-xs text-accent hover:underline">
            Get help
          </Link>
          <Link href="/login" className="text-xs text-ink-subtle hover:text-ink">
            Expert sign in
          </Link>
        </div>
      </div>
    </header>
  );
}
