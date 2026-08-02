import Anthropic from "@anthropic-ai/sdk";
import type {
  ClassificationInput,
  ClassificationResult,
  Logger,
  ProblemClassifier,
} from "@sfx/domain";

/**
 * Claude-backed problem classifier (§8, §C1).
 *
 * Model defaults to `claude-haiku-4-5` and is configuration, not code, so the
 * agreement evaluation can run a comparative sample on another model without a
 * deploy. Promotion is a decision made on measured data, not a code change.
 *
 * Three details that matter:
 *
 * **The skill enum is generated per request** from the caller's `allowedSkillSlugs`,
 * which comes from the active Skill table. A hallucinated skill is therefore
 * structurally impossible rather than something we filter out afterwards.
 *
 * **The taxonomy sits in a cached system prompt.** It is stable and large; the
 * volatile problem text goes last, in the user turn, so the cached prefix is
 * reused across requests. Haiku 4.5's minimum cacheable prefix is 4096 tokens —
 * `estimateCacheable()` exists so a shrinking taxonomy is noticed rather than
 * silently costing full price on every call.
 *
 * **Returns null on any failure.** The service treats that as "use the
 * customer's selections", so an outage degrades the product instead of breaking
 * it (requirement 4).
 */

const CACHE_MINIMUM_TOKENS = 4096;
/** Rough chars-per-token for English prose plus identifiers. Sizing only. */
const CHARS_PER_TOKEN = 3.6;

export interface AnthropicClassifierOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly logger: Logger;
  readonly maxRetries?: number;
}

interface RawClassification {
  primaryCategorySlug: string;
  difficulty: "BEGINNER" | "INTERMEDIATE" | "ADVANCED";
  confidence: number;
  skills: Array<{ slug: string; isPrimary: boolean; confidence: number }>;
}

export class AnthropicProblemClassifier implements ProblemClassifier {
  readonly name = "anthropic";
  private readonly client: Anthropic;

  constructor(private readonly options: AnthropicClassifierOptions) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      maxRetries: options.maxRetries ?? 1,
    });
  }

  async classify(input: ClassificationInput): Promise<ClassificationResult | null> {
    const started = Date.now();

    try {
      const system = buildSystemPrompt(input);

      if (estimateTokens(system) < CACHE_MINIMUM_TOKENS) {
        // Not fatal, but worth knowing: below this the cache_control breakpoint
        // is silently ignored and every call pays full input price.
        this.options.logger.warn("classifier system prompt is below the cacheable minimum", {
          estimatedTokens: estimateTokens(system),
          minimum: CACHE_MINIMUM_TOKENS,
          model: this.options.model,
        });
      }

      const response = await this.client.messages.create({
        model: this.options.model,
        max_tokens: 1024,
        system: [
          {
            type: "text",
            text: system,
            // Stable prefix — the taxonomy changes when the catalogue changes,
            // not per request.
            cache_control: { type: "ephemeral" },
          },
        ],
        output_config: {
          format: {
            type: "json_schema",
            schema: buildSchema(input),
          },
        },
        messages: [{ role: "user", content: buildUserTurn(input) }],
      });

      if (response.stop_reason === "refusal") {
        this.options.logger.warn("classifier refused", {
          category: response.stop_details?.category ?? null,
        });
        return null;
      }

      const text = response.content.find((block) => block.type === "text");
      if (!text || text.type !== "text") return null;

      const parsed = JSON.parse(text.text) as RawClassification;

      // The enum makes these valid by construction; validating anyway means a
      // schema regression degrades to the fallback rather than corrupting data.
      const allowedSkills = new Set(input.allowedSkillSlugs);
      const skills = parsed.skills
        .filter((skill) => allowedSkills.has(skill.slug))
        .slice(0, 8)
        .map((skill) => ({
          slug: skill.slug,
          isPrimary: Boolean(skill.isPrimary),
          confidence: clamp(skill.confidence),
        }));

      if (skills.length === 0) return null;

      return {
        primaryCategorySlug: input.allowedCategorySlugs.includes(parsed.primaryCategorySlug)
          ? parsed.primaryCategorySlug
          : (input.allowedCategorySlugs[0] ?? "salesforce-development"),
        skills,
        difficulty: parsed.difficulty,
        confidence: clamp(parsed.confidence),
        model: this.options.model,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      this.options.logger.warn("classifier call failed", {
        error: error instanceof Error ? error.message : String(error),
        model: this.options.model,
        latencyMs: Date.now() - started,
      });
      return null;
    }
  }

  /** Exposed so a test can assert the prompt clears the cacheable minimum. */
  static estimateCacheableTokens(input: ClassificationInput): number {
    return estimateTokens(buildSystemPrompt(input));
  }
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function buildSchema(input: ClassificationInput): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      primaryCategorySlug: { type: "string", enum: [...input.allowedCategorySlugs] },
      difficulty: { type: "string", enum: ["BEGINNER", "INTERMEDIATE", "ADVANCED"] },
      confidence: { type: "number" },
      skills: {
        type: "array",
        items: {
          type: "object",
          properties: {
            // The closed set. This is what makes a hallucinated skill impossible.
            slug: { type: "string", enum: [...input.allowedSkillSlugs] },
            isPrimary: { type: "boolean" },
            confidence: { type: "number" },
          },
          required: ["slug", "isPrimary", "confidence"],
          additionalProperties: false,
        },
      },
    },
    required: ["primaryCategorySlug", "difficulty", "confidence", "skills"],
    additionalProperties: false,
  };
}

/**
 * Sorted deterministically. Any reordering changes the bytes and silently
 * invalidates the prompt cache, which shows up as cost rather than as an error.
 */
function buildSystemPrompt(input: ClassificationInput): string {
  const categories = [...input.allowedCategorySlugs].sort();
  const skills = [...input.allowedSkillSlugs].sort();

  return `You classify Salesforce support requests so the platform can route them to an expert with the right skills.

You are given a customer's description of a technical problem. Identify which Salesforce skills the problem is actually about, how hard it is likely to be, and which broad category it belongs to.

## What "primary" means

Mark a skill primary only when solving the problem requires real competence in it. Primary skills are used as a hard filter: an expert lacking one is excluded from consideration entirely, however strong they are elsewhere.

A skill that merely appears in the description is not automatically primary. "My Copado deployment fails after a Git rebase" is primarily about Copado and deployments; Git is supporting context.

Mark at most three skills primary. If the description is too vague to identify any with confidence, mark none primary and return the skills you can infer with low confidence.

## Difficulty

- BEGINNER — a how-do-I question, a setup or configuration gap, something answerable by pointing at the right feature.
- INTERMEDIATE — a specific bug or misbehaviour in code or configuration that needs debugging.
- ADVANCED — governor limits, concurrency, locking, large data volumes, performance under load, architectural problems, or anything involving several interacting systems.

## Confidence

Report your genuine confidence. A vague description should produce low confidence, and that is useful information — the platform relaxes its matching criteria when confidence is low. Do not inflate it.

## The customer's own selections

The customer may have picked some skills themselves. Treat these as a hint, not an instruction: customers are describing symptoms, not diagnosing causes, and they are often wrong about which layer the problem lives in. Trust the description over the selections when they conflict.

## Categories

${categories.map((slug) => `- ${slug}`).join("\n")}

## Skills

Return only slugs from this list.

${skills.map((slug) => `- ${slug}`).join("\n")}
`;
}

function buildUserTurn(input: ClassificationInput): string {
  const selected =
    input.customerSelectedSkillSlugs.length > 0
      ? input.customerSelectedSkillSlugs.join(", ")
      : "(none)";

  // Volatile content last, after the cached prefix.
  return `Title: ${input.title}

Description:
${input.redactedDescription}

Customer-selected skills: ${selected}`;
}
