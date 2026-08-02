import type {
  ClassificationInput,
  ClassificationResult,
  ClassifiedSkill,
  ProblemClassifier,
} from "@sfx/domain";

/**
 * Keyword classifier over the skill taxonomy's own aliases.
 *
 * Two jobs, both real:
 *
 * 1. **Local development and CI** need the whole flow to work without an API key.
 *    A stub returning `null` would exercise only the failure path, and we would
 *    never see a classified request until someone added billing.
 *
 * 2. **A deterministic baseline.** When we measure the model's agreement with
 *    customer selections, "better than keyword matching" is the bar it has to
 *    clear. A model that cannot beat this is not worth its latency.
 *
 * It reads the `aliases` already in the Skill table, so it improves as the
 * taxonomy does, with no code change.
 */

export interface RulesClassifierOptions {
  /** slug → display name + aliases, supplied by the caller from the database. */
  readonly vocabulary: ReadonlyMap<
    string,
    { readonly name: string; readonly aliases: readonly string[]; readonly categorySlug: string }
  >;
}

/** Word-boundary match that tolerates the punctuation real prose contains. */
function mentions(haystack: string, needle: string): number {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[\s_-]+/g, "[\\s_-]+");
  const regex = new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "gi");
  return (haystack.match(regex) ?? []).length;
}

/**
 * Signals that the problem is harder than average. Used for `difficulty`, which
 * feeds the matching engine's experience weighting in Phase 5.
 */
const ADVANCED_SIGNALS = [
  "governor limit",
  "cpu time",
  "heap size",
  "too many soql",
  "row lock",
  "unable_to_lock_row",
  "race condition",
  "bulk api",
  "concurrent",
  "deadlock",
  "architecture",
  "large data volume",
  "ldv",
  "skew",
];

const BEGINNER_SIGNALS = [
  "how do i",
  "how to",
  "where is",
  "cannot find",
  "can't find",
  "getting started",
  "new to",
  "beginner",
];

export class RulesProblemClassifier implements ProblemClassifier {
  readonly name = "rules";

  constructor(private readonly options: RulesClassifierOptions) {}

  async classify(input: ClassificationInput): Promise<ClassificationResult | null> {
    const started = Date.now();
    // The port's contract: the description arrives already redacted.
    const haystack = `${input.title}\n${input.redactedDescription}`.toLowerCase();

    const allowed = new Set(input.allowedSkillSlugs);
    const scored: Array<{ slug: string; hits: number; categorySlug: string }> = [];

    for (const [slug, entry] of this.options.vocabulary) {
      if (!allowed.has(slug)) continue;

      // The display name counts double: "Apex" appearing verbatim is a stronger
      // signal than an alias like "async apex" firing incidentally.
      let hits = mentions(haystack, entry.name) * 2;
      for (const alias of entry.aliases) hits += mentions(haystack, alias);
      // Slugs are hyphenated, which `mentions` normalises, so "soql-sosl" also
      // matches "SOQL SOSL".
      hits += mentions(haystack, slug.replace(/-/g, " "));

      if (hits > 0) scored.push({ slug, hits, categorySlug: entry.categorySlug });
    }

    // The customer's own selections are folded in rather than competing. They
    // are assistive input (requirement 2): treated as evidence, never as a
    // diagnosis that overrides the description.
    for (const slug of input.customerSelectedSkillSlugs) {
      if (!allowed.has(slug)) continue;
      const existing = scored.find((s) => s.slug === slug);
      if (existing) {
        existing.hits += 2;
      } else {
        const entry = this.options.vocabulary.get(slug);
        if (entry) scored.push({ slug, hits: 2, categorySlug: entry.categorySlug });
      }
    }

    if (scored.length === 0) {
      // Honest failure: nothing recognised. Better to say so and let the
      // customer's selections stand than to invent a category.
      return null;
    }

    scored.sort((a, b) => b.hits - a.hits);
    const top = scored.slice(0, 6);
    const maxHits = top[0]?.hits ?? 1;

    const skills: ClassifiedSkill[] = top.map((entry) => ({
      slug: entry.slug,
      // Primary means "the problem is about this", which drives the hard
      // competence floor in Phase 5 — so the bar is deliberately high.
      isPrimary: entry.hits >= Math.max(2, maxHits * 0.6),
      confidence: Math.min(0.95, 0.35 + (entry.hits / maxHits) * 0.5),
    }));

    // Primary category = whichever category the strongest signals cluster in.
    const categoryVotes = new Map<string, number>();
    for (const entry of top) {
      categoryVotes.set(
        entry.categorySlug,
        (categoryVotes.get(entry.categorySlug) ?? 0) + entry.hits,
      );
    }
    const primaryCategorySlug =
      [...categoryVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ??
      input.allowedCategorySlugs[0] ??
      "salesforce-development";

    return {
      primaryCategorySlug,
      skills,
      difficulty: this.assessDifficulty(haystack),
      // Capped well below certainty. This is keyword matching, and the
      // confidence it reports should never imply more than that.
      confidence: Math.min(0.7, 0.3 + top.length * 0.08),
      model: "rules-v1",
      latencyMs: Date.now() - started,
    };
  }

  private assessDifficulty(haystack: string): ClassificationResult["difficulty"] {
    if (ADVANCED_SIGNALS.some((signal) => haystack.includes(signal))) return "ADVANCED";
    if (BEGINNER_SIGNALS.some((signal) => haystack.includes(signal))) return "BEGINNER";
    return "INTERMEDIATE";
  }
}
