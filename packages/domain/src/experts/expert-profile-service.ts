import { authorize, type Actor } from "../authorization/index.js";
import type { Clock } from "../ports/clock.js";
import type { ExpertProfileEdit, ExpertProfileRepository } from "../ports/expert-repositories.js";
import type {
  AuditLogRepository,
  ExpertApplicationRecord,
  ExpertApplicationRepository,
} from "../ports/repositories.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";

/**
 * Profile editing after approval (requirement 8).
 *
 * An approved expert keeps their profile current — they change employer, add a
 * certification, rewrite a summary — without that touching anything
 * administrative.
 *
 * The protection is an **allowlist expressed in the type**, not a set of
 * `delete input.status` guards. `ExpertProfileEdit` has no field for status,
 * verification, review notes, submission timestamps, or the denormalised
 * metrics, so there is nothing for a hostile payload to set and nothing for a
 * future column to become self-editable by omission.
 */

/** Named so a test can assert the boundary rather than trusting the type alone. */
export const SELF_EDITABLE_PROFILE_FIELDS = [
  "country",
  "timezone",
  "yearsExperience",
  "professionalSummary",
  "languages",
  "certifications",
  "linkedinUrl",
  "githubUrl",
  "employmentStatus",
] as const;

/**
 * Explicitly out of reach. Kept as data so the test that enforces requirement 8
 * reads as a specification rather than as a restatement of the code.
 */
export const ADMIN_ONLY_PROFILE_FIELDS = [
  "status",
  "statusChangedAt",
  "submittedAt",
  "reviewedByUserId",
  "reviewNotes",
  "availabilityStatus",
  "lastHeartbeatAt",
  "sessionsCompleted",
  "ratingSum",
  "ratingCount",
  "offersReceived",
  "offersAccepted",
  "payoutRecipientRef",
  "payoutsEnabled",
] as const;

export interface ExpertProfileServiceDeps {
  readonly profiles: ExpertProfileRepository;
  readonly applications: ExpertApplicationRepository;
  readonly auditLog: AuditLogRepository;
  readonly clock: Clock;
}

export class ExpertProfileService {
  constructor(private readonly deps: ExpertProfileServiceDeps) {}

  async getOwn(actor: Actor): Promise<ExpertApplicationRecord> {
    authorize(actor, "expert_profile:read_own");
    return this.requireOwn(actor);
  }

  /**
   * Apply a profile edit.
   *
   * Available in any status — a DRAFT applicant filling in the wizard and an
   * APPROVED expert updating their summary are the same operation on the same
   * fields. What differs is that an approved edit does **not** send them back
   * for review: re-approving someone because they changed employer would be
   * bureaucratic, and none of these fields alter eligibility.
   */
  async updateOwn(
    actor: Actor,
    edit: ExpertProfileEdit | Record<string, unknown>,
  ): Promise<ExpertApplicationRecord> {
    authorize(actor, "expert_profile:update_own");
    const before = await this.requireOwn(actor);
    const now = this.deps.clock.now();

    if (Object.keys(edit).length === 0) {
      throw new ValidationError("Nothing to update.");
    }
    const summary = (edit as ExpertProfileEdit).professionalSummary;
    if (summary !== undefined && summary.trim().length < 80) {
      throw new ValidationError("Your summary is how we and customers understand your depth.", {
        professionalSummary: ["Please write at least a couple of sentences."],
      });
    }

    // Filtered here, in the domain, rather than relying on the adapter to write
    // only known columns. The invariant is then testable without a database,
    // and a second adapter cannot reintroduce the hole by being less careful.
    await this.deps.profiles.applyEdit({
      expertProfileId: before.id,
      edit: allowlist(edit as Record<string, unknown>),
      now,
    });

    const after = await this.requireOwn(actor);

    // Approved profiles are what customers are matched against, so a change to
    // one is worth a record even though it needs no approval.
    if (before.status === "APPROVED") {
      await this.deps.auditLog.record({
        actorUserId: actor.userId,
        actorType: "EXPERT",
        action: "expert_profile.updated",
        entityType: "ExpertProfile",
        entityId: before.id,
        before: pick(before),
        after: pick(after),
      });
    }

    return after;
  }

  private async requireOwn(actor: Actor): Promise<ExpertApplicationRecord> {
    if (!actor.expert) throw new ForbiddenError("edit expert profile", `user:${actor.userId}`);
    const record = await this.deps.applications.findById(actor.expert.profileId);
    if (!record) throw new NotFoundError("ExpertProfile", actor.expert.profileId);
    if (record.userId !== actor.userId) {
      throw new ForbiddenError("edit expert profile", `expert:${record.id}`);
    }
    return record;
  }
}

/**
 * Keeps only the allowlisted keys.
 *
 * Requirement 8's actual enforcement point. A payload carrying `status` or
 * `verified` loses them here, before anything reaches persistence — so the
 * protection does not depend on the type being respected at the boundary, on
 * Zod stripping unknown keys, or on the adapter being careful.
 */
function allowlist(edit: Record<string, unknown>): ExpertProfileEdit {
  const result: Record<string, unknown> = {};
  for (const field of SELF_EDITABLE_PROFILE_FIELDS) {
    if (field in edit) result[field] = edit[field];
  }
  return result as ExpertProfileEdit;
}

/** Only the self-editable fields go in the audit diff — the rest is noise. */
function pick(record: ExpertApplicationRecord): Record<string, unknown> {
  return {
    country: record.country,
    timezone: record.timezone,
    yearsExperience: record.yearsExperience,
    professionalSummary: record.professionalSummary,
    languages: record.languages,
    certifications: record.certifications,
    linkedinUrl: record.linkedinUrl,
    githubUrl: record.githubUrl,
    employmentStatus: record.employmentStatus,
  };
}
