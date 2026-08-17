import type { ExpertStatus } from "@sfx/contracts";
import { authorize, type Actor } from "../authorization/index.js";
import type { Clock } from "../ports/clock.js";
import type {
  ExpertApplicationDraft,
  ExpertApplicationRecord,
  Repositories,
  UnitOfWork,
} from "../ports/repositories.js";
import { ConflictError, NotFoundError, ValidationError } from "../shared/errors.js";
import { assertExpertTransition, missingForSubmission } from "./expert-status.js";

/**
 * Expert application use cases — the applicant's side.
 *
 * Every method authorizes first, against the domain policy, using an Actor the
 * caller built from the session. No method trusts a role, an id, or a status
 * that arrived in a request body (requirement 4).
 */
export class ExpertApplicationService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  /**
   * Start an application.
   *
   * Requirement 1: an existing customer who applies keeps the same account.
   * This adds the EXPERT role to their user row and creates a DRAFT profile —
   * it never creates a second identity. After this the user is dual-role, and
   * both dashboards are theirs.
   *
   * Requirement 2: the new EXPERT role confers nothing. The profile is DRAFT,
   * so `isEligibleForMatching` is false and stays false until an admin approves.
   */
  async start(actor: Actor): Promise<ExpertApplicationRecord> {
    authorize(actor, "expert_application:start");
    const now = this.clock.now();

    return this.uow.transaction(async (repos) => {
      const existing = await repos.expertApplications.findByUserId(actor.userId);
      if (existing) {
        // Idempotent: a double-submitted "become an expert" form returns the
        // application already in flight rather than creating a second one.
        return existing;
      }

      let application: ExpertApplicationRecord;
      try {
        application = await repos.expertApplications.create(actor.userId);
      } catch (error) {
        // Two concurrent starts both read null above, then both insert. The
        // unique constraint on userId makes exactly one win; the loser lands
        // here and returns the winner's row, so a race is an idempotent success
        // rather than a 500. Re-reading is the whole point — the row now exists.
        if (error instanceof ConflictError) {
          const raced = await repos.expertApplications.findByUserId(actor.userId);
          if (raced) return raced;
        }
        throw error;
      }

      await repos.users.addRole(actor.userId, "EXPERT");

      await repos.auditLog.record({
        actorUserId: actor.userId,
        actorType: "EXPERT",
        action: "expert_application.started",
        entityType: "ExpertProfile",
        entityId: application.id,
        before: null,
        after: { status: application.status, at: now.toISOString() },
      });

      return application;
    });
  }

  async getOwn(actor: Actor): Promise<ExpertApplicationRecord> {
    authorize(actor, "expert_application:read_own");
    return this.requireOwn(this.uow, actor);
  }

  async saveDraft(actor: Actor, draft: ExpertApplicationDraft): Promise<ExpertApplicationRecord> {
    authorize(actor, "expert_application:update_own");
    const now = this.clock.now();

    return this.uow.transaction(async (repos) => {
      const application = await this.requireOwn(repos, actor);

      // A rejected application returns to DRAFT the moment it is edited, so the
      // applicant can rework it. Rejection is recoverable, not terminal.
      if (application.status === "REJECTED") {
        assertExpertTransition("REJECTED", "DRAFT", "EXPERT");
        await repos.expertApplications.updateStatus({
          id: application.id,
          status: "DRAFT",
          now,
        });
        await repos.auditLog.record({
          actorUserId: actor.userId,
          actorType: "EXPERT",
          action: "expert_application.reopened",
          entityType: "ExpertProfile",
          entityId: application.id,
          before: { status: "REJECTED" },
          after: { status: "DRAFT", at: now.toISOString() },
        });
      }

      return repos.expertApplications.updateDraft(application.id, draft, now);
    });
  }

  /**
   * Submit for review.
   *
   * Completeness is enforced here rather than by the database, because the
   * columns are nullable on purpose — a draft is genuinely incomplete, and
   * placeholder values would be a worse representation of "unanswered".
   */
  async submit(actor: Actor): Promise<ExpertApplicationRecord> {
    authorize(actor, "expert_application:submit_own");
    const now = this.clock.now();

    /*
      Vetting starts here, not at the admin's desk.

      An unverified address means we have no way to reach this person — and
      every later check assumes we can. Someone may browse and ask for help
      without confirming their email; offering themselves as an expert is
      different, because the platform would be putting a stranger it cannot
      contact in front of a customer's production org.

      Enforced at submission rather than at login on purpose: it is a product
      rule about who may be offered as an expert, not a rule about who may sign
      in, and the two do not belong in the same place.
    */
    if (!actor.emailVerified) {
      throw new ValidationError(
        "Confirm your email address before submitting your application. Check your inbox for the link.",
        { email: ["not yet verified"] },
      );
    }

    return this.uow.transaction(async (repos) => {
      const application = await this.requireOwn(repos, actor);
      assertExpertTransition(application.status, "SUBMITTED", "EXPERT");

      const missing = missingForSubmission(application);
      if (missing.length > 0) {
        throw new ValidationError(
          "Application is not complete enough to submit.",
          Object.fromEntries(missing.map((field) => [field, ["required before submitting"]])),
        );
      }

      const updated = await repos.expertApplications.updateStatus({
        id: application.id,
        status: "SUBMITTED",
        now,
        submittedAt: now,
      });

      await repos.auditLog.record({
        actorUserId: actor.userId,
        actorType: "EXPERT",
        action: "expert_application.submitted",
        entityType: "ExpertProfile",
        entityId: application.id,
        before: { status: application.status },
        after: { status: "SUBMITTED", at: now.toISOString() },
      });

      return updated;
    });
  }

  private async requireOwn(repos: Repositories, actor: Actor): Promise<ExpertApplicationRecord> {
    const application = await repos.expertApplications.findByUserId(actor.userId);
    if (!application) throw new NotFoundError("ExpertProfile", `user:${actor.userId}`);
    // Belt and braces: the policy already scoped this to the actor's own
    // application, but ownership is re-checked against the row we actually read.
    if (application.userId !== actor.userId) {
      throw new ConflictError("Application does not belong to the requesting user.");
    }
    return application;
  }
}

export type ExpertReviewDecision = Extract<ExpertStatus, "APPROVED" | "REJECTED" | "UNDER_REVIEW">;
