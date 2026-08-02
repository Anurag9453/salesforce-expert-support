import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { PricingTierView, TaxonomyCategory } from "@sfx/contracts";
import { Alert, buttonClasses } from "@/components/ui";
import { RequestForm } from "@/components/request/request-form";
import { getContainer } from "@/lib/container";
import { requireActor } from "@/lib/session";

export const metadata: Metadata = { title: "Get expert help" };
export const dynamic = "force-dynamic";

export default async function RequestHelpPage() {
  const actor = await requireActor();
  const { supportRequests, taxonomy, pricing } = getContainer();

  // One live request at a time — two would compete for the same experts and
  // hold two authorizations on the customer's card.
  const active = await supportRequests.findActive(actor);
  if (active) redirect(`/request/${active.id}`);

  const [categories, skills, tiers] = await Promise.all([
    taxonomy.listActiveCategories(),
    taxonomy.listActiveSkills(),
    pricing.listActiveTiers("INR"),
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
      <Alert tone="warning" title="No session types are available">
        Pricing has not been configured yet. Run <code>pnpm db:seed</code>.
      </Alert>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <Link href="/dashboard" className="text-xs text-ink-muted hover:text-ink">
          ← Dashboard
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink">Get expert help</h1>
        <p className="mt-1.5 text-sm text-ink-muted">
          Describe the problem in your own words. We&rsquo;ll work out who can fix it.
        </p>
      </header>

      <RequestForm categories={grouped} tiers={tierViews} />

      <p className="border-t border-border pt-5 text-xs text-ink-subtle">
        Not ready?{" "}
        <Link href="/dashboard" className={buttonClasses({ variant: "ghost", size: "sm" })}>
          Back to dashboard
        </Link>
      </p>
    </div>
  );
}
