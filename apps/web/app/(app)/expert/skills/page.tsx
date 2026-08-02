import type { TaxonomyCategory } from "@sfx/contracts";
import { can, MAX_SKILLS_PER_EXPERT, PROFICIENCY_GUIDANCE } from "@sfx/domain";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SkillsManager } from "@/components/expert/skills-manager";
import { Alert } from "@/components/ui";
import { toExpertSkillView } from "@/lib/availability-view";
import { getContainer } from "@/lib/container";
import { requireActor } from "@/lib/session";

export const metadata: Metadata = { title: "Your skills" };
export const dynamic = "force-dynamic";

/**
 * Skill management (§10).
 *
 * Open to any expert with an application — including DRAFT. Skills are part of
 * what a reviewer assesses, so making the page wait for approval would be
 * backwards. What approval gates is *availability*, not describing yourself.
 */
export default async function ExpertSkillsPage() {
  const actor = await requireActor();
  if (!actor.expert || !can(actor, "expert_skill:read_own")) redirect("/dashboard");

  const { expertSkills, taxonomy } = getContainer();
  const [skills, categories, allSkills] = await Promise.all([
    expertSkills.listOwn(actor),
    taxonomy.listActiveCategories(),
    taxonomy.listActiveSkills(),
  ]);

  const grouped: TaxonomyCategory[] = categories.map((category) => ({
    slug: category.slug,
    name: category.name,
    skills: allSkills
      .filter((skill) => skill.categorySlug === category.slug)
      .map((skill) => ({ slug: skill.slug, name: skill.name })),
  }));

  return (
    <div className="space-y-6">
      <header>
        <Link href="/expert" className="text-sm text-ink-muted hover:text-ink">
          ← Expert workspace
        </Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight text-ink">Your skills</h1>
        <p className="mt-1 text-sm text-ink-muted">
          This is what we match on. Customers never browse experts — they describe a problem and we
          route it, so the accuracy of this list is what puts the right work in front of you.
        </p>
      </header>

      <Alert tone="info" title="Self-declared, then verified">
        Everything here starts as your own assessment. Our review team verifies individual skills
        after seeing evidence; you cannot mark your own as verified, and neither can we do it
        silently — every verification is recorded against the admin who made it.
      </Alert>

      <SkillsManager
        initial={skills.map(toExpertSkillView)}
        categories={grouped}
        guidance={PROFICIENCY_GUIDANCE}
        maxSkills={MAX_SKILLS_PER_EXPERT}
      />
    </div>
  );
}
