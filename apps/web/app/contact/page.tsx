import type { Metadata } from "next";
import Link from "next/link";
import { Alert, Badge, buttonClasses, Card, CardBody } from "@/components/ui";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = {
  title: "Contact",
  description: "How to reach us about a request, an application, or your data.",
};

/**
 * Contact.
 *
 * No form here on purpose. There is already a form that captures a problem
 * properly — with the description, the duration and the redaction warning — and a
 * second, vaguer one would collect worse information and split where enquiries
 * land. This page routes people to the right door instead.
 *
 * The addresses are placeholders until the domain exists. Deliberately obvious
 * ones: a plausible-looking address that bounces is worse than a blank you can
 * see, particularly on the page a regulator would look at first.
 */
export default function ContactPage() {
  return (
    <main className="min-h-dvh">
      <SiteHeader />

      <div className="mx-auto max-w-3xl px-6 py-14">
        <Badge tone="accent">Contact</Badge>
        <h1 className="font-display mt-4 text-3xl leading-tight font-medium text-balance text-ink">
          Getting hold of us
        </h1>
        <p className="mt-4 text-sm leading-relaxed text-ink-muted">
          If you have a Salesforce problem, the request form is the fastest route — it asks the
          things we would have to ask you anyway.
        </p>

        <Link
          href="/request-help"
          className={buttonClasses({ size: "lg", className: "mt-6 w-full sm:w-auto" })}
        >
          Describe your problem
        </Link>

        <Alert tone="warning" className="mt-8" title="Before you write to us">
          Please do not include passwords, access tokens, private keys, or production customer data
          in any message. We never need your credentials to help, and email is not a safe place to
          put them.
        </Alert>

        <h2 className="font-display mt-12 text-xl font-medium text-ink">By email</h2>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          {[
            {
              heading: "General enquiries",
              address: "hello@[DOMAIN]",
              body: "Questions about how this works, or anything the site does not answer.",
            },
            {
              heading: "Experts",
              address: "experts@[DOMAIN]",
              body: "Questions about an application, your profile, or work you have been offered.",
            },
            {
              heading: "Privacy and your data",
              address: "privacy@[DOMAIN]",
              body: "A copy of what we hold, a correction, or a deletion request. See the privacy notice for what we do with each.",
            },
            {
              heading: "Something is wrong",
              address: "support@[DOMAIN]",
              body: "A session that did not happen, an expert who did not show, or anything you would want a human to look at.",
            },
          ].map((item) => (
            <Card key={item.heading}>
              <CardBody className="p-5">
                <h3 className="font-display text-base font-medium text-ink">{item.heading}</h3>
                <p className="mt-1 font-mono text-xs text-accent">{item.address}</p>
                <p className="mt-2 text-sm leading-relaxed text-ink-muted">{item.body}</p>
              </CardBody>
            </Card>
          ))}
        </div>

        <h2 className="font-display mt-12 text-xl font-medium text-ink">The legal entity</h2>
        <p className="mt-3 text-sm leading-relaxed text-ink-muted">
          Salesforce Expert Support is operated by [LEGAL ENTITY NAME], registered in [JURISDICTION]
          under company number [NUMBER], at [REGISTERED ADDRESS].
        </p>
        <p className="mt-3 text-sm leading-relaxed text-ink-subtle">
          These details are not filled in yet. They will be before the site takes money or is
          advertised, because a business that collects personal data owes you a name and an address
          you can act against.
        </p>
      </div>

      <SiteFooter />
    </main>
  );
}
