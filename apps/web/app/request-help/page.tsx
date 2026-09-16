import { DEFAULT_CURRENCY } from "@sfx/contracts";
import { ANONYMOUS } from "@sfx/domain";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { PricingTierView, TaxonomyCategory } from "@sfx/contracts";
import { Alert } from "@/components/ui";
import { SiteFooter } from "@/components/site-footer";
import { LandingHeader } from "@/components/landing/landing-header";
import { SpecialtyGrid } from "@/components/landing/specialty-grid";
import { LeadWizard } from "@/components/request/lead-wizard";
import { RequestWizard } from "@/components/request/request-wizard";
import { getContainer } from "@/lib/container";
import { serverEnv } from "@/lib/env";
import { getActor } from "@/lib/session";
import { resolveSpecialty, shortCategoryName, specialtyHeadline } from "@/lib/specialty";

export const metadata: Metadata = { title: "Hire a Salesforce expert" };
export const dynamic = "force-dynamic";

export default async function RequestHelpPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; specialty?: string }>;
}) {
  const params = await searchParams;
  const actor = await getActor();
  const signedIn = actor !== ANONYMOUS;
  const leadCapture = serverEnv().INTAKE_MODE === "lead_capture";

  const { supportRequests, taxonomy, pricing } = getContainer();

  if (signedIn && !leadCapture) {
    const active = await supportRequests.findActive(actor);
    if (active) redirect(`/request/${active.id}`);
  }

  const [categories, skills, tiers] = await Promise.all([
    taxonomy.listActiveCategories(),
    taxonomy.listActiveSkills(),
    pricing.listActiveTiers(DEFAULT_CURRENCY),
  ]);

  const grouped: TaxonomyCategory[] = categories.map((category) => ({
    slug: category.slug,
    name: category.name,
    skills: skills
      .filter((skill) => skill.categorySlug === category.slug)
      .map((skill) => ({ slug: skill.slug, name: skill.name })),
  }));

  const specialty = resolveSpecialty(
    { q: params.q, specialty: params.specialty },
    grouped,
  );
  const freeText = specialty ? null : (params.q?.trim() || null);

  const tierViews: PricingTierView[] = tiers.map((tier) => ({
    id: tier.id,
    name: tier.name,
    durationMinutes: tier.durationMinutes,
    priceCents: tier.priceCents,
    currency: tier.currency,
  }));

  if (tierViews.length === 0) {
    return (
      <div className="min-h-dvh">
        <LandingHeader />
        <div className="mx-auto max-w-2xl px-6 py-16">
          <Alert tone="warning" title="No session types are available">
            Pricing has not been configured yet. Run <code>pnpm db:setup</code>.
          </Alert>
        </div>
      </div>
    );
  }

  const headline = specialty
    ? specialtyHeadline(specialty)
    : freeText
      ? `Help with “${freeText}”`
      : "Hire a Salesforce expert";

  const lede = specialty
    ? `Tell us about the ${specialty.skillName ?? shortCategoryName(specialty.categoryName)} work. We match you to a vetted expert in this specialty.`
    : "Pick a specialty, or describe the work — we match you to a vetted expert.";

  return (
    <div className="min-h-dvh overflow-x-clip">
      <LandingHeader />

      <section className="landing-hero">
        <div className="mx-auto max-w-6xl px-6 py-10 sm:py-12">
          {specialty ? (
            <p className="text-xs font-medium tracking-wide text-white/55 uppercase">
              {specialty.categoryName}
              {specialty.skills.length > 0 ? ` · ${String(specialty.skills.length)} skills` : ""}
            </p>
          ) : (
            <p className="text-xs font-medium tracking-wide text-white/55 uppercase">Request help</p>
          )}
          <h1 className="font-display mt-2 max-w-2xl text-[clamp(1.7rem,4.5vw,2.6rem)] leading-[1.15] font-semibold break-words text-wrap text-white">
            {headline}
          </h1>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-white/70">{lede}</p>
          {specialty ? (
            <Link
              href="/request-help"
              className="mt-4 inline-block text-xs font-medium text-white/70 underline-offset-2 hover:text-white hover:underline"
            >
              Change specialty
            </Link>
          ) : null}
        </div>
      </section>

      <main className="mx-auto max-w-3xl px-6 py-8 sm:py-10">
        {specialty || freeText ? (
          leadCapture ? (
            <LeadWizard tiers={tierViews} specialty={specialty} freeText={freeText} />
          ) : (
            <RequestWizard
              categories={grouped}
              tiers={tierViews}
              signedIn={signedIn}
              payBeforeMatch={serverEnv().DISPATCH_MODE !== "interest_pool"}
              initialCategorySlug={specialty?.categorySlug ?? null}
              initialSkillSlugs={specialty?.skillSlug ? [specialty.skillSlug] : []}
              initialDescription={freeText ?? ""}
            />
          )
        ) : (
          <SpecialtyGrid />
        )}
      </main>

      <SiteFooter />
    </div>
  );
}
