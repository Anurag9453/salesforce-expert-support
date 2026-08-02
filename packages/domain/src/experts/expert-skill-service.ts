import type { ProficiencyLevel } from "@sfx/contracts";
import { authorize, type Actor } from "../authorization/index.js";
import type { Clock } from "../ports/clock.js";
import type { ExpertSkillRecord, ExpertSkillRepository } from "../ports/expert-repositories.js";
import type { AuditLogRepository, ExpertApplicationRepository } from "../ports/repositories.js";
import type { TaxonomyRepository } from "../ports/request-repositories.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";

/**
 * Expert skills (§10, requirements 1, 2 and 7).
 *
 * A skill claim is `(skill, self-rated proficiency, years with that specific
 * skill)`. Years-with-this-skill is separate from years-of-Salesforce-experience
 * on the profile, and the difference matters: eight years in Salesforce and six
 * months of CPQ is a common and honest shape, and the matching engine needs to
 * see it rather than inferring depth from tenure.
 *
 * Requirement 2 is enforced structurally rather than by checking a flag. The
 * expert-facing methods take an `ExpertSkillDeclaration`, which has no
 * `verified` field at all — there is no value a client could send, and no
 * handler that could forward one.
 */

export const MAX_SKILLS_PER_EXPERT = 30;

/**
 * Requirement 7 — the honest bar for each level.
 *
 * Anti-inflation is a copy problem as much as a policy one. Left to "Beginner /
 * Intermediate / Advanced / Expert" with no definitions, everyone picks Expert.
 * Anchoring each level to observable behaviour makes over-claiming an active
 * choice rather than the path of least resistance — and once verification and
 * ratings exist, an inflated claim costs the expert real declined offers.
 */
export const PROFICIENCY_GUIDANCE: Record<
  ProficiencyLevel,
  { label: string; description: string }
> = {
  BEGINNER: {
    label: "Learning",
    description: "You have used it and can find your way around with documentation open.",
  },
  INTERMEDIATE: {
    label: "Working knowledge",
    description: "You handle everyday problems here without help, and know where the limits are.",
  },
  ADVANCED: {
    label: "Strong",
    description: "You debug the difficult cases and other people ask you about this one.",
  },
  EXPERT: {
    label: "Deep",
    description:
      "You have solved this at scale, repeatedly, and could teach it. Pick this sparingly — it is what we match the hardest problems on.",
  },
};

export interface ExpertSkillServiceDeps {
  readonly skills: ExpertSkillRepository;
  readonly taxonomy: TaxonomyRepository;
  readonly applications: ExpertApplicationRepository;
  readonly auditLog: AuditLogRepository;
  readonly clock: Clock;
}

export interface DeclareSkillInput {
  readonly skillSlug: string;
  readonly proficiencyLevel: ProficiencyLevel;
  readonly yearsExperience: number;
}

export class ExpertSkillService {
  constructor(private readonly deps: ExpertSkillServiceDeps) {}

  async listOwn(actor: Actor): Promise<readonly ExpertSkillRecord[]> {
    authorize(actor, "expert_skill:read_own");
    return this.deps.skills.listForExpert(this.requireExpertId(actor));
  }

  /**
   * Declare or update one of the expert's own skills.
   *
   * Note what is absent: no path to `verified`. Re-declaring a verified skill
   * clears the verification at the repository layer, because the claim being
   * vouched for has changed.
   */
  async declare(actor: Actor, input: DeclareSkillInput): Promise<ExpertSkillRecord> {
    authorize(actor, "expert_skill:update_own");
    const expertProfileId = this.requireExpertId(actor);
    const now = this.deps.clock.now();

    const [skill] = await this.deps.taxonomy.findSkillsBySlug([input.skillSlug]);
    if (!skill) throw new NotFoundError("Skill", input.skillSlug);

    if (!Number.isInteger(input.yearsExperience) || input.yearsExperience < 0) {
      throw new ValidationError("Years of experience must be a whole number of years.", {
        yearsExperience: ["Enter 0 or more."],
      });
    }
    if (input.yearsExperience > 40) {
      throw new ValidationError("That is more years than Salesforce has existed.", {
        yearsExperience: ["Enter 40 or fewer."],
      });
    }

    const existing = await this.deps.skills.listForExpert(expertProfileId);
    const isNew = !existing.some((entry) => entry.skillId === skill.id);
    if (isNew && existing.length >= MAX_SKILLS_PER_EXPERT) {
      // Requirement 7, structurally: a cap is the bluntest available discouragement
      // from listing the entire taxonomy. Thirty is generous for a real specialist
      // and still short of "everything".
      throw new ValidationError(
        `You can list up to ${MAX_SKILLS_PER_EXPERT} skills. Remove one to add another — a focused list matches better than an exhaustive one.`,
        { skills: [`Limit of ${MAX_SKILLS_PER_EXPERT} reached.`] },
      );
    }

    const wasVerified = existing.find((entry) => entry.skillId === skill.id)?.verified ?? false;

    const record = await this.deps.skills.declare({
      expertProfileId,
      declaration: {
        skillId: skill.id,
        proficiencyLevel: input.proficiencyLevel,
        yearsExperience: input.yearsExperience,
      },
      now,
    });

    if (wasVerified) {
      // Worth an audit row: an expert editing away a verification is legitimate
      // but is exactly the sort of thing someone will later ask about.
      await this.deps.auditLog.record({
        actorUserId: actor.userId,
        actorType: "EXPERT",
        action: "expert_skill.verification_cleared_by_edit",
        entityType: "ExpertSkill",
        entityId: record.id,
        before: { verified: true },
        after: {
          verified: false,
          proficiencyLevel: input.proficiencyLevel,
          yearsExperience: input.yearsExperience,
        },
      });
    }

    return record;
  }

  async remove(actor: Actor, skillSlug: string): Promise<void> {
    authorize(actor, "expert_skill:update_own");
    const expertProfileId = this.requireExpertId(actor);
    const [skill] = await this.deps.taxonomy.findSkillsBySlug([skillSlug]);
    if (!skill) throw new NotFoundError("Skill", skillSlug);
    await this.deps.skills.remove({ expertProfileId, skillId: skill.id });
  }

  // ── Admin ──────────────────────────────────────────────────────────────────

  async listForExpert(
    actor: Actor,
    expertProfileId: string,
  ): Promise<readonly ExpertSkillRecord[]> {
    authorize(actor, "admin:read_experts");
    return this.deps.skills.listForExpert(expertProfileId);
  }

  /**
   * The only write path to `verified` (requirement 2).
   *
   * Admin-only, audited, and reachable from no expert-facing route.
   */
  async setVerified(
    actor: Actor,
    params: { expertProfileId: string; skillSlug: string; verified: boolean; notes: string },
  ): Promise<ExpertSkillRecord> {
    authorize(actor, "admin:verify_expert_skill");

    if (params.notes.trim().length === 0) {
      throw new ValidationError("Record why this skill is being verified.", {
        notes: ["A reason is required."],
      });
    }

    const application = await this.deps.applications.findById(params.expertProfileId);
    if (!application) throw new NotFoundError("ExpertProfile", params.expertProfileId);

    const [skill] = await this.deps.taxonomy.findSkillsBySlug([params.skillSlug]);
    if (!skill) throw new NotFoundError("Skill", params.skillSlug);

    const now = this.deps.clock.now();
    const record = await this.deps.skills.setVerified({
      expertProfileId: params.expertProfileId,
      skillId: skill.id,
      verified: params.verified,
      adminUserId: actor.userId,
      now,
    });

    await this.deps.auditLog.record({
      actorUserId: actor.userId,
      actorType: "ADMIN",
      action: params.verified ? "expert_skill.verified" : "expert_skill.unverified",
      entityType: "ExpertSkill",
      entityId: record.id,
      before: { verified: !params.verified },
      after: {
        verified: params.verified,
        skill: skill.slug,
        verifiedByEmail: actor.email,
        notes: params.notes,
        at: now.toISOString(),
      },
    });

    return record;
  }

  private requireExpertId(actor: Actor): string {
    if (!actor.expert) throw new ForbiddenError("manage skills", `user:${actor.userId}`);
    return actor.expert.profileId;
  }
}
