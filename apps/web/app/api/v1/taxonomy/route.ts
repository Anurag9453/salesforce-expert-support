import { DEFAULT_CURRENCY } from "@sfx/contracts";
import type { PricingTierView, TaxonomyCategory } from "@sfx/contracts";
import { apiOk, handleRoute } from "@/lib/route-helpers";
import { getContainer } from "@/lib/container";
import { requireActor } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Categories, skills, and pricing for the request form.
 *
 * One call rather than three, because the form needs all of it before it can
 * render and a customer waiting on a waterfall is a customer who leaves.
 */
export async function GET() {
  return handleRoute(async () => {
    await requireActor();
    const { taxonomy, pricing } = getContainer();

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

    return apiOk({ categories: grouped, tiers: tierViews });
  });
}
