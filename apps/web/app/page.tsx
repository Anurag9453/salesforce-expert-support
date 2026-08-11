import Link from "next/link";
import { Badge, buttonClasses } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * The front door.
 *
 * This replaces the Phase 1 scaffold, which still announced "Phase 1 ·
 * Foundation" and offered two disabled buttons — the first thing every visitor
 * saw was a build status board.
 *
 * Everything stated here is something the system actually does. No metrics, no
 * testimonials, no customer logos: the product has not launched, so any number
 * on this page would be invented. The one figure quoted — 15 minutes — is the
 * real `matchDeadlineAt` window, and the copy says "usually" because that is a
 * deadline, not a promise.
 */

const STEPS = [
  {
    n: "01",
    title: "Describe the problem",
    body: "In your own words — no forms to decode, no category tree to navigate. Credentials and keys are stripped out before anything is stored.",
  },
  {
    n: "02",
    title: "We find the right expert",
    body: "Your problem is read for the skills it actually needs, then matched against experts proven at that depth. You never browse a directory.",
  },
  {
    n: "03",
    title: "They accept, you talk",
    body: "The offer goes to the best-matched expert who is online right now. If they pass, it moves on within a minute.",
  },
] as const;

const PRINCIPLES = [
  {
    title: "Depth is a floor, not a preference",
    body: "An expert who is merely adjacent to your problem is never offered it. We would rather tell you nobody is available than connect you to the wrong person.",
  },
  {
    title: "Nobody bids for your work",
    body: "There are no proposals, no rate negotiation, no shortlist to review. Pricing is set by the platform and the match is made for you.",
  },
  {
    title: "Every match is explainable",
    body: "Each decision records who was considered, who was ruled out, and why. Support can answer why one expert was chosen over another.",
  },
] as const;

export default function Page() {
  return (
    <main className="min-h-dvh">
      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <section className="aurora overflow-hidden">
        <div className="blueprint">
          <div className="mx-auto max-w-5xl px-6 pt-20 pb-16 sm:pt-28 sm:pb-24">
            <div className="animate-fade-in">
              <Badge tone="available" pulse>
                Experts online now
              </Badge>
            </div>

            <h1 className="animate-rise-in font-display mt-6 max-w-3xl text-[clamp(2.5rem,6vw,4.25rem)] leading-[1.05] font-medium text-balance text-ink">
              Salesforce help,{" "}
              {/* Fraunces' italic is where the calligraphic character is most obvious. */}
              <em className="text-accent italic">without the search.</em>
            </h1>

            <p
              className="animate-rise-in mt-6 max-w-xl text-base leading-relaxed text-ink-muted"
              style={{ animationDelay: "80ms" }}
            >
              Describe what is broken. We match you to an expert with genuine depth in exactly that
              area — usually within fifteen minutes. No directory, no proposals, no guesswork.
            </p>

            {/*
              The fork, stated as two equal choices rather than one call to
              action and a smaller link. Which side of the marketplace someone is
              on is the first thing we need to know, and burying "become an
              expert" as a footnote is how a marketplace ends up with demand and
              no supply.

              These route; they do not brand anyone permanently. One account can
              hold both roles, so an expert can raise a request and a client can
              apply later (requirement 1).
            */}
            <div
              className="animate-rise-in mt-10 grid gap-4 sm:grid-cols-2"
              style={{ animationDelay: "160ms" }}
            >
              <EntryCard
                href="/request-help"
                eyebrow="I need help"
                title="Hire a Salesforce expert"
                body="Describe the problem and we match you to someone with real depth in it. No account needed to start."
                cta="Get expert help"
                primary
              />
              <EntryCard
                href="/expert-application"
                eyebrow="I can help"
                title="Become a Salesforce expert"
                body="Paid work matched to your actual strengths. Applications are reviewed by a human, with identity and photo checks."
                cta="Apply as an expert"
              />
            </div>

            <p
              className="animate-fade-in mt-5 text-xs text-ink-subtle"
              style={{ animationDelay: "240ms" }}
            >
              Already have an account?{" "}
              <Link href="/login" className="text-accent underline-offset-2 hover:underline">
                Sign in
              </Link>
            </p>
          </div>
        </div>
      </section>

      {/* ── How it works ──────────────────────────────────────────────────── */}
      <section className="border-t border-border bg-surface-raised">
        <div className="mx-auto max-w-5xl px-6 py-16 sm:py-20">
          <SectionHeading eyebrow="How it works" title="Three steps, one of which is yours" />

          <ol className="stagger mt-10 grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-3">
            {STEPS.map((step) => (
              <li
                key={step.n}
                className="interactive group bg-surface-raised p-6 hover:bg-surface-sunken/60"
              >
                <span
                  data-numeric
                  className="font-display text-2xl leading-none font-medium text-accent/35 transition-colors duration-300 group-hover:text-accent"
                >
                  {step.n}
                </span>
                <h3 className="mt-4 text-sm font-semibold text-ink">{step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-muted">{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ── What makes it different ───────────────────────────────────────── */}
      <section>
        <div className="mx-auto max-w-5xl px-6 py-16 sm:py-20">
          <div className="grid gap-12 lg:grid-cols-[minmax(0,20rem)_1fr] lg:gap-16">
            <SectionHeading
              eyebrow="Why it works"
              title="Built to route, not to list"
              description="A marketplace optimises for choice. Instant support optimises for the right answer arriving fast — which needs the opposite of a directory."
            />

            <dl className="stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
              {PRINCIPLES.map((principle) => (
                <div
                  key={principle.title}
                  className="interactive rounded-xl border border-border bg-surface-raised p-5 shadow-flat hover:-translate-y-0.5 hover:border-accent/25 hover:shadow-raised"
                >
                  <dt className="font-display text-lg font-medium text-ink">{principle.title}</dt>
                  <dd className="mt-2 text-sm leading-relaxed text-ink-muted">{principle.body}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </section>

      {/* ── Closing call to action ────────────────────────────────────────── */}
      <section className="border-t border-border bg-surface-raised">
        <div className="mx-auto max-w-5xl px-6 py-16 sm:py-20">
          <div className="aurora relative overflow-hidden rounded-xl border border-border bg-surface px-6 py-12 text-center shadow-raised sm:px-12">
            <h2 className="font-display mx-auto max-w-xl text-3xl leading-tight font-medium text-balance text-ink sm:text-4xl">
              Stop reading forum threads from 2019.
            </h2>
            <p className="mx-auto mt-4 max-w-md text-sm leading-relaxed text-ink-muted">
              Describe the problem once. We will find the person who has already solved it.
            </p>
            <Link href="/register" className={buttonClasses({ size: "lg", className: "mt-8" })}>
              Get expert help
            </Link>
          </div>
        </div>
      </section>

      {/* ── Footer, carrying the data-safety notice ───────────────────────── */}
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-10 sm:flex-row sm:items-start sm:justify-between">
          <p className="font-display text-sm font-medium text-ink">Salesforce Expert Support</p>
          <p className="max-w-md text-xs leading-relaxed text-ink-subtle">
            Never share passwords, access tokens, private keys, or production customer data through
            this platform. Health Cloud technical support is in scope; actual patient data is not.
          </p>
        </div>
      </footer>
    </main>
  );
}

function EntryCard({
  href,
  eyebrow,
  title,
  body,
  cta,
  primary,
}: {
  href: string;
  eyebrow: string;
  title: string;
  body: string;
  cta: string;
  primary?: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "interactive group flex flex-col rounded-xl border bg-surface-raised p-6 text-left",
        "hover:-translate-y-0.5 hover:shadow-lifted",
        primary
          ? "border-accent/40 shadow-raised"
          : "border-border shadow-flat hover:border-accent/30",
      )}
    >
      <span className="text-xs font-medium tracking-[0.08em] text-accent uppercase">{eyebrow}</span>
      <span className="font-display mt-2 text-xl font-medium text-ink">{title}</span>
      <span className="mt-2 flex-1 text-sm leading-relaxed text-ink-muted">{body}</span>
      <span
        className={cn(
          buttonClasses({ variant: primary ? "primary" : "secondary", size: "md" }),
          "mt-5 w-full",
        )}
      >
        {cta}
        <span aria-hidden="true" className="transition-transform group-hover:translate-x-0.5">
          →
        </span>
      </span>
    </Link>
  );
}

function SectionHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description?: string;
}) {
  return (
    <div className="animate-rise-in">
      <p className="text-xs font-medium tracking-[0.08em] text-accent uppercase">{eyebrow}</p>
      <h2 className="font-display mt-3 max-w-md text-3xl leading-tight font-medium text-balance text-ink">
        {title}
      </h2>
      {description && (
        <p className="mt-4 max-w-sm text-sm leading-relaxed text-ink-muted">{description}</p>
      )}
    </div>
  );
}
