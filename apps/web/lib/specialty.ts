import type { TaxonomyCategory } from "@sfx/contracts";

export type ResolvedSpecialty = {
  categorySlug: string;
  categoryName: string;
  skills: ReadonlyArray<{ slug: string; name: string }>;
  skillSlug: string | null;
  skillName: string | null;
  query: string | null;
};

const QUERY_ALIASES: Record<string, { category?: string; skill?: string }> = {
  apex: { skill: "apex" },
  lwc: { skill: "lwc" },
  "lightning web components": { skill: "lwc" },
  flow: { skill: "flow" },
  cpq: { skill: "revenue-cloud-cpq" },
  "revenue cloud": { skill: "revenue-cloud-cpq" },
  "marketing cloud": { skill: "marketing-cloud" },
  sfmc: { skill: "marketing-cloud" },
  agentforce: { category: "agentforce" },
  "sales cloud": { skill: "sales-cloud" },
  "service cloud": { skill: "service-cloud" },
  "experience cloud": { skill: "experience-cloud" },
  "data cloud": { skill: "data-cloud" },
  "field service": { skill: "field-service" },
  "health cloud": { skill: "health-cloud" },
  omnistudio: { category: "omnistudio" },
  omniscripts: { skill: "omniscripts" },
  devops: { category: "salesforce-devops" },
  mulesoft: { category: "mulesoft" },
  development: { category: "salesforce-development" },
  configuration: { category: "salesforce-configuration" },
  clouds: { category: "salesforce-clouds" },
};

function norm(value: string): string {
  return value.trim().toLowerCase();
}

function pack(
  category: TaxonomyCategory,
  skill: { slug: string; name: string } | null,
  query: string | null,
): ResolvedSpecialty {
  return {
    categorySlug: category.slug,
    categoryName: category.name,
    skills: category.skills,
    skillSlug: skill?.slug ?? null,
    skillName: skill?.name ?? null,
    query,
  };
}

export function resolveSpecialty(
  params: { q?: string; specialty?: string },
  categories: TaxonomyCategory[],
): ResolvedSpecialty | null {
  const q = params.q?.trim() ?? "";
  const specialty = params.specialty?.trim() ?? "";
  if (!q && !specialty) return null;

  const bySlug = new Map(categories.map((category) => [category.slug, category]));
  const allSkills = categories.flatMap((category) =>
    category.skills.map((skill) => ({ skill, category })),
  );

  if (specialty) {
    const category =
      bySlug.get(specialty) ?? categories.find((item) => norm(item.name) === norm(specialty));
    if (category) {
      const fromQuery = q
        ? category.skills.find((skill) => skill.slug === norm(q) || norm(skill.name) === norm(q))
        : null;
      return pack(category, fromQuery ?? null, q || null);
    }
  }

  if (!q) return null;

  const key = norm(q);
  const alias = QUERY_ALIASES[key];
  if (alias?.skill) {
    const hit = allSkills.find((item) => item.skill.slug === alias.skill);
    if (hit) return pack(hit.category, hit.skill, q);
  }
  if (alias?.category) {
    const category = bySlug.get(alias.category);
    if (category) return pack(category, null, q);
  }

  const skillExact = allSkills.find(
    (item) => item.skill.slug === key || norm(item.skill.name) === key,
  );
  if (skillExact) return pack(skillExact.category, skillExact.skill, q);

  const skillPartial = allSkills.find(
    (item) => norm(item.skill.name).includes(key) || key.includes(norm(item.skill.name)),
  );
  if (skillPartial) return pack(skillPartial.category, skillPartial.skill, q);

  const categoryHit = categories.find(
    (item) =>
      item.slug === key ||
      norm(item.name) === key ||
      norm(item.name).includes(key) ||
      key.includes(norm(item.name.replace(/^Salesforce\s+/i, ""))),
  );
  if (categoryHit) return pack(categoryHit, null, q);

  return null;
}

export function specialtyHeadline(resolved: ResolvedSpecialty): string {
  if (resolved.skillName) return `Hire ${resolved.skillName} experts`;
  return `Hire ${shortCategoryName(resolved.categoryName)} specialists`;
}

export function shortCategoryName(name: string): string {
  return name.replace(/^Salesforce\s+/i, "");
}
