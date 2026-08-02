import type { ExpertStatus } from "@sfx/contracts";
import { authorize, type Actor } from "../authorization/index.js";
import type { Clock } from "../ports/clock.js";
import type {
  AuditLogEntryRecord,
  ExpertApplicationRecord,
  UnitOfWork,
} from "../ports/repositories.js";
import { NotFoundError, ValidationError } from "../shared/errors.js";
import { assertExpertTransition, REVIEWABLE_STATUSES } from "./expert-status.js";

/**
 * Administrative side of the expert lifecycle (§25).
 *
 * Requirement 3 in practice: every decision here records who made it, when, and
 * which transition — in the same transaction as the status change, so a status
 * can never move without its audit row. That is the difference between an audit
 * trail and a hopeful log line.
 */
export class ExpertAdminService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async listPendingReview(
    actor: Actor,
    params: { limit?: number; cursor?: string } = {},
  ): Promise<{ items: readonly ExpertApplicationRecord[]; nextCursor?: string }> {
    authorize(actor, "admin:read_experts");
    return this.uow.expertApplications.listByStatus({
      statuses: REVIEWABLE_STATUSES,
      limit: Math.min(params.limit ?? 25, 100),
      ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
    });
  }

  async listByStatus(
    actor: Actor,
    statuses: readonly ExpertStatus[],
    params: { limit?: number; cursor?: string } = {},
  ): Promise<{ items: readonly ExpertApplicationRecord[]; nextCursor?: string }> {
    authorize(actor, "admin:read_experts");
    return this.uow.expertApplications.listByStatus({
      statuses,
      limit: Math.min(params.limit ?? 25, 100),
      ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
    });
  }

  async get(actor: Actor, applicationId: string): Promise<ExpertApplicationRecord> {
    authorize(actor, "admin:read_experts");
    const application = await this.uow.expertApplications.findById(applicationId);
    if (!application) throw new NotFoundError("ExpertProfile", applicationId);
    return application;
  }

  /** Requirement 3 — the lifecycle history for one application, newest first. */
  async history(actor: Actor, applicationId: string): Promise<readonly AuditLogEntryRecord[]> {
    authorize(actor, "admin:read_experts");
    return this.uow.auditLog.listForEntity({
      entityType: "ExpertProfile",
      entityId: applicationId,
      limit: 100,
    });
  }

  /** Claim an application for review. Optional — an admin may decide directly. */
  async claimForReview(actor: Actor, applicationId: string): Promise<ExpertApplicationRecord> {
    authorize(actor, "admin:review_expert");
    return this.applyDecision(actor, applicationId, "UNDER_REVIEW", null, "expert.claimed");
  }

  async approve(
    actor: Actor,
    applicationId: string,
    notes: string,
  ): Promise<ExpertApplicationRecord> {
    authorize(actor, "admin:review_expert");
    return this.applyDecision(actor, applicationId, "APPROVED", notes, "expert.approved");
  }

  async reject(
    actor: Actor,
    applicationId: string,
    notes: string,
  ): Promise<ExpertApplicationRecord> {
    authorize(actor, "admin:review_expert");
    return this.applyDecision(actor, applicationId, "REJECTED", notes, "expert.rejected");
  }

  /**
   * Suspension takes effect immediately: the status leaves APPROVED, and
   * `isEligibleForMatching` is false from that moment. No separate "disable"
   * flag exists to fall out of sync with it.
   */
  async suspend(
    actor: Actor,
    applicationId: string,
    reason: string,
  ): Promise<ExpertApplicationRecord> {
    authorize(actor, "admin:suspend_expert");
    return this.applyDecision(actor, applicationId, "SUSPENDED", reason, "expert.suspended");
  }

  async reinstate(
    actor: Actor,
    applicationId: string,
    reason: string,
  ): Promise<ExpertApplicationRecord> {
    authorize(actor, "admin:reinstate_expert");
    return this.applyDecision(actor, applicationId, "APPROVED", reason, "expert.reinstated");
  }

  private async applyDecision(
    actor: Actor,
    applicationId: string,
    target: ExpertStatus,
    notes: string | null,
    action: string,
  ): Promise<ExpertApplicationRecord> {
    const now = this.clock.now();

    return this.uow.transaction(async (repos) => {
      const application = await repos.expertApplications.findById(applicationId);
      if (!application) throw new NotFoundError("ExpertProfile", applicationId);

      const rule = assertExpertTransition(application.status, target, "ADMIN");

      // Requirement 3: a decision without a stated reason is not auditable, so
      // the machine declares which transitions need one and this enforces it.
      if (rule.requiresReason && (notes === null || notes.trim().length === 0)) {
        throw new ValidationError(
          `A reason is required to move an expert from ${application.status} to ${target}.`,
          { notes: ["required for this decision"] },
        );
      }

      const updated = await repos.expertApplications.updateStatus({
        id: application.id,
        status: target,
        now,
        reviewedByUserId: actor.userId,
        reviewNotes: notes,
      });

      await repos.auditLog.record({
        actorUserId: actor.userId,
        actorType: "ADMIN",
        action,
        entityType: "ExpertProfile",
        entityId: application.id,
        before: {
          status: application.status,
          statusChangedAt: application.statusChangedAt.toISOString(),
        },
        after: {
          status: target,
          statusChangedAt: now.toISOString(),
          reviewedByUserId: actor.userId,
          reviewedByEmail: actor.email,
          notes,
        },
      });

      return updated;
    });
  }
}
