import type { Metadata } from "next";
import Link from "next/link";
import { Badge, buttonClasses, Card, CardBody } from "@/components/ui";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = {
  title: "About",
  description:
    "What this is, how experts are vetted, and what is and is not live yet. A marketplace for Salesforce help.",
};

/**
 * About.
 *
 * Written to be true rather than impressive, which mostly meant deleting things.
 * No invented numbers of experts, no response-time promise the product does not
 * keep, no claim that matching is automatic while a human is doing the routing.
 * A visitor deciding whether to hand over a problem is better served by knowing
 * where the edges are.
 *
 * The "what is not live yet" section is deliberate and stays until it is empty.
 * Somebody who reads it and comes back anyway is a better customer than somebody
 * who discovers it after submitting.
 */
export default function AboutPage() {
  return (
    <main className="min-h-dvh">
      <SiteHeader />

      <div className="mx-auto max-w-3xl px-6 py-14">
        <Badge tone="accent">About</Badge>
        <h1 className="font-display mt-4 text-3xl leading-tight font-medium text-balance text-ink">
          Salesforce help, without the search
        </h1>
        <p className="mt-4 text-sm leading-relaxed text-ink-muted">
          Finding a Salesforce expert is harder than it should be. The good ones are busy, the job
          boards are full of generalists, and the forum thread that matches your problem is from
          2019 and unresolved. Meanwhile whatever is broken stays broken.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-ink-muted">
          This is a smaller idea than a marketplace with a search box. You describe the problem
          once, in your own words. We read it and put it in front of someone who has already solved
          that particular thing — not someone whose profile happens to list the right keywords.
        </p>

        {/* ── What you can ask for ─────────────────────────────────────────── */}
        <h2 className="font-display mt-12 text-xl font-medium text-ink">Four ways to ask</h2>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          {[
            {
              title: "Instant",
              body: "Something is broken now. Tell us how long you think you need — 30, 60 or 120 minutes — and we come back with the right person.",
            },
            {
              title: "Scheduled",
              body: "The same thing, at a time you choose. Pick the slot and your time zone; we confirm before anyone calls.",
            },
            {
              title: "Long-term",
              body: "A retainer or a continuing engagement. Tell us the shape of the work, roughly how long, and your budget.",
            },
            {
              title: "Certification",
              body: "Preparation for a specific credential — a study plan, the topics that are not landing, mock exams, or a retake after a near miss.",
            },
          ].map((item) => (
            <Card key={item.title}>
              <CardBody className="p-5">
                <h3 className="font-display text-base font-medium text-ink">{item.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{item.body}</p>
              </CardBody>
            </Card>
          ))}
        </div>
        <p className="mt-4 text-sm leading-relaxed text-ink-muted">
          You do not need an account for any of it. Accounts exist for experts, because they are
          being paid and we have to know who they are.
        </p>

        {/* ── Vetting ──────────────────────────────────────────────────────── */}
        <h2 className="font-display mt-12 text-xl font-medium text-ink">
          How experts get on the list
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-ink-muted">
          Every application is read by a person before it is approved. Nothing is automatic, and the
          list is deliberately short rather than deliberately large.
        </p>
        <ul className="mt-4 space-y-3">
          {[
            ["A verified email address", "Confirmed before an application can be submitted."],
            [
              "A working phone number",
              "Mandatory. It is how we reach someone when a session is about to start and they are not there.",
            ],
            [
              "A public Trailhead profile",
              "Checked against what the application claims. Certifications are easy to assert and easy to verify, so we verify them.",
            ],
            [
              "A photo, reviewed by a human",
              "Customers are about to share a screen with this person. A face that matches the name is the least we can do.",
            ],
            [
              "Skills declared per area, not as a list of buzzwords",
              "An expert says where they are strong; we route on that rather than on keyword overlap.",
            ],
          ].map(([title, body]) => (
            <li key={title} className="flex gap-3">
              <span
                aria-hidden="true"
                className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent"
              />
              <span className="text-sm leading-relaxed text-ink-muted">
                <span className="font-medium text-ink">{title}.</span> {body}
              </span>
            </li>
          ))}
        </ul>

        {/* ── Commercials ──────────────────────────────────────────────────── */}
        <h2 className="font-display mt-12 text-xl font-medium text-ink">What it costs</h2>
        <p className="mt-3 text-sm leading-relaxed text-ink-muted">
          Session prices are published rather than quoted: $21 for 30 minutes, $36.35 for an hour,
          $51.80 for two. The price you see includes the card processing fee, so it is the amount
          you would actually pay.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-ink-muted">
          We are an intermediary, not the expert. The person doing the work keeps the large majority
          of what you pay; we keep a percentage for finding them, vetting them, and being the one
          you complain to. Long-term and certification work is priced per engagement, because a
          retainer is not a number we can print on a page.
        </p>

        {/* ── Honest limits ────────────────────────────────────────────────── */}
        <h2 className="font-display mt-12 text-xl font-medium text-ink">What is not live yet</h2>
        <p className="mt-3 text-sm leading-relaxed text-ink-muted">
          This is a young product and it is easier to say so than to be found out.
        </p>
        <ul className="mt-4 space-y-3">
          {[
            [
              "Payment on the site",
              "You are not asked for card details anywhere. We agree the work with you first and arrange payment separately.",
            ],
            [
              "Instant matching",
              "Requests are routed by our team by hand. Expect to hear back the same working day rather than in fifteen minutes.",
            ],
            [
              "Video sessions in the browser",
              "Calls happen on a link we send you, not inside this site.",
            ],
          ].map(([title, body]) => (
            <li key={title} className="flex gap-3">
              <span
                aria-hidden="true"
                className="mt-1.5 size-1.5 shrink-0 rounded-full bg-border-strong"
              />
              <span className="text-sm leading-relaxed text-ink-muted">
                <span className="font-medium text-ink">{title}.</span> {body}
              </span>
            </li>
          ))}
        </ul>

        <div className="mt-12 rounded-xl border border-border bg-surface-raised p-6">
          <h2 className="font-display text-lg font-medium text-ink">Have something broken?</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
            Describe it once. No account, no card, no call scheduled before you know who you are
            talking to.
          </p>
          <Link
            href="/request-help"
            className={buttonClasses({ size: "lg", className: "mt-5 w-full sm:w-auto" })}
          >
            Get a Salesforce expert
          </Link>
        </div>
      </div>

      <SiteFooter />
    </main>
  );
}
