import { DEFAULT_CURRENCY } from "@sfx/contracts";
import { ANONYMOUS } from "@sfx/domain";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { PricingTierView, TaxonomyCategory } from "@sfx/contracts";
import { Alert } from "@/components/ui";
import { RequestWizard } from "@/components/request/request-wizard";
import { getContainer } from "@/lib/container";
import { getActor } from "@/lib/session";

export const metadata: Metadata = { title: "Get expert help" };
export const dynamic = "force-dynamic";

/**
 * Intake, reachable **without an account**.
 *
 * Deliberately outside the authenticated route group. Someone whose production
 * org is broken should be able to start describing it from the landing page
 * without being bounced to a login screen first — and being bounced was exactly
 * what happened while this page lived under `(app)`.
 *
 * Identity is collected later, inside the wizard, once they have actually written
 * something. See `/api/v1/guest` for why that still creates a real account.
 *
 * Minimal chrome on purpose: no nav, no bell. This is a focused flow with a
 * single outcome, and a header full of links to elsewhere is a header full of
 * ways to abandon it.
 */
export default async function RequestHelpPage() {
  const actor = await getActor();
  const signedIn = actor !== ANONYMOUS;

  const { supportRequests, taxonomy, pricing } = getContainer();

  // One live request at a time — two would compete for the same experts and hold
  // two authorizations on the same card. Only checkable when we know who they are.
  if (signedIn) {
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

  const tierViews: PricingTierView[] = tiers.map((tier) => ({
    id: tier.id,
    name: tier.name,
    durationMinutes: tier.durationMinutes,
    priceCents: tier.priceCents,
    currency: tier.currency,
  }));

  if (tierViews.length === 0) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16">
        <Alert tone="warning" title="No session types are available">
          Pricing has not been configured yet. Run <code>pnpm db:setup</code>.
        </Alert>
      </div>
    );
  }

  return (
    <div className="aurora min-h-dvh">
      <header className="border-b border-border bg-surface-raised/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-2xl items-center justify-between px-6">
          <Link
            href="/"
            className="font-display interactive text-[0.9375rem] font-medium tracking-tight text-ink hover:text-accent"
          >
            Salesforce Expert Support
          </Link>
          {signedIn ? (
            <Link href="/dashboard" className="text-xs text-ink-muted hover:text-ink">
              Dashboard
            </Link>
          ) : (
            <Link href="/login" className="text-xs text-accent hover:underline">
              Sign in
            </Link>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-6 py-10">
        <h1 className="font-display text-3xl leading-tight font-medium text-balance text-ink">
          Get expert help
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-muted">
          Describe the problem in your own words. We&rsquo;ll work out who can fix it.
        </p>

        <div className="mt-8">
          <RequestWizard categories={grouped} tiers={tierViews} signedIn={signedIn} />
        </div>
      </main>
    </div>
  );
}
