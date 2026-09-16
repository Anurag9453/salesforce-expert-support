import type { Metadata } from "next";
import Link from "next/link";
import { ANONYMOUS } from "@sfx/domain";
import { SiteFooter } from "@/components/site-footer";
import { LandingHeader } from "@/components/landing/landing-header";
import { getActor } from "@/lib/session";

export const metadata: Metadata = {
  title: {
    absolute: "Salesforce Expert Support — Hire talent or work as a freelancer",
  },
  description:
    "Hire vetted Salesforce experts, or log in as a freelancer to take matched work.",
};

export const dynamic = "force-dynamic";

export default async function Page() {
  const signedIn = (await getActor()) !== ANONYMOUS;

  return (
    <main className="min-h-dvh overflow-x-clip">
      <LandingHeader />

      <section className="landing-hero">
        <div className="mx-auto max-w-6xl px-6 py-16 sm:py-24">
          <h1 className="font-display max-w-2xl text-[clamp(1.85rem,5.5vw,3.15rem)] leading-[1.12] font-semibold break-words text-wrap text-white">
            Salesforce talent, on demand.
          </h1>
          <p className="mt-4 max-w-lg text-sm leading-relaxed text-white/70 sm:text-base">
            Clients hire vetted experts. Freelancers log in to take matched work.
          </p>

          <div className="mt-10 grid max-w-3xl gap-4 sm:grid-cols-2">
            <Link
              href={signedIn ? "/hire" : "/hire/start"}
              className="interactive rounded-xl bg-white p-6 shadow-lifted hover:-translate-y-0.5"
            >
              <p className="text-xs font-semibold tracking-wide text-accent uppercase">I am a client</p>
              <h2 className="mt-2 text-lg font-semibold text-ink">Hire Talent</h2>
              <p className="mt-2 text-sm leading-relaxed text-ink-muted">
                Browse specialties like Agentforce, Sales Cloud, and Apex, then request an expert.
              </p>
            </Link>

            <Link
              href="/login"
              className="interactive rounded-xl border border-white/15 bg-white/8 p-6 hover:bg-white/12"
            >
              <p className="text-xs font-semibold tracking-wide text-white/70 uppercase">
                I am a freelancer
              </p>
              <h2 className="mt-2 text-lg font-semibold text-white">Login as Freelancer</h2>
              <p className="mt-2 text-sm leading-relaxed text-white/70">
                Sign in with Google or email to get matched to paid Salesforce work.
              </p>
            </Link>
          </div>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
