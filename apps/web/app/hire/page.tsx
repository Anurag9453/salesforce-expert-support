import type { Metadata } from "next";
import { SiteFooter } from "@/components/site-footer";
import { HeroSearch } from "@/components/landing/hero-search";
import { LandingHeader } from "@/components/landing/landing-header";
import { SpecialtyGrid } from "@/components/landing/specialty-grid";

export const metadata: Metadata = {
  title: "Hire Salesforce talent",
  description:
    "Browse Salesforce specialties — Agentforce, Sales Cloud, Service Cloud, Apex, and more — and hire a vetted expert.",
};

const STEPS = [
  {
    n: "1",
    title: "Describe the work",
    body: "Instant, scheduled, retainer, or certification — no account needed.",
  },
  {
    n: "2",
    title: "Get matched",
    body: "We route it to a vetted expert with that skill, not a keyword match.",
  },
  {
    n: "3",
    title: "Start the session",
    body: "They accept, you talk. Platform pricing — no bidding.",
  },
] as const;

export default function HirePage() {
  return (
    <main className="min-h-dvh overflow-x-clip">
      <LandingHeader />

      <section className="landing-hero">
        <div className="mx-auto max-w-6xl px-6 py-12 sm:py-16">
          <p className="text-xs font-medium tracking-wide text-white/55 uppercase">For clients</p>
          <h1 className="font-display mt-2 max-w-2xl text-[clamp(1.85rem,5.5vw,3.25rem)] leading-[1.12] font-semibold break-words text-wrap text-white">
            Hire vetted Salesforce experts.
          </h1>
          <p className="mt-4 max-w-lg text-sm leading-relaxed text-wrap text-white/70 sm:text-base">
            Describe the problem once. We match you on skill — usually within fifteen minutes.
          </p>
          <div className="mt-8 w-full min-w-0">
            <HeroSearch />
          </div>
        </div>
      </section>

      <section id="skills" className="scroll-mt-20 border-b border-border">
        <div className="mx-auto max-w-6xl px-6 py-10 sm:py-12">
          <SpecialtyGrid title="Browse by specialty" />
        </div>
      </section>

      <section id="how-it-works" className="scroll-mt-20">
        <div className="mx-auto max-w-6xl px-6 py-10 sm:py-12">
          <h2 className="font-display text-xl font-medium text-ink">How it works</h2>
          <ol className="mt-5 grid gap-4 sm:grid-cols-3">
            {STEPS.map((step) => (
              <li key={step.n}>
                <p data-numeric className="text-xs font-semibold text-accent">
                  {step.n}
                </p>
                <h3 className="mt-1 text-sm font-semibold text-ink">{step.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-ink-muted">{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
