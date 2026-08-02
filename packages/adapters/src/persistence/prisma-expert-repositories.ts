import type { AvailabilityStatus, ProficiencyLevel } from "@sfx/contracts";
import type { PrismaClient, PrismaTransactionClient } from "@sfx/db";
import type {
  AvailabilityChangeSource,
  AvailabilityLogEntry,
  ExpertAvailabilityRepository,
  ExpertPresenceRecord,
  ExpertProfileEdit,
  ExpertProfileRepository,
  ExpertSkillDeclaration,
  ExpertSkillRecord,
  ExpertSkillRepository,
} from "@sfx/domain";

type Db = PrismaClient | PrismaTransactionClient;

// ── Availability & presence ──────────────────────────────────────────────────

export class PrismaExpertAvailabilityRepository implements ExpertAvailabilityRepository {
  constructor(private readonly db: Db) {}

  async findPresence(expertProfileId: string): Promise<ExpertPresenceRecord | null> {
    const row = await this.db.expertProfile.findUnique({
      where: { id: expertProfileId },
      select: {
        id: true,
        userId: true,
        availabilityStatus: true,
        lastHeartbeatAt: true,
        lastAvailableAt: true,
        lastAssignedAt: true,
        lastSessionCompletedAt: true,
      },
    });
    if (!row) return null;
    return {
      expertProfileId: row.id,
      userId: row.userId,
      availabilityStatus: row.availabilityStatus,
      lastHeartbeatAt: row.lastHeartbeatAt,
      lastAvailableAt: row.lastAvailableAt,
      lastAssignedAt: row.lastAssignedAt,
      lastSessionCompletedAt: row.lastSessionCompletedAt,
    };
  }

  /**
   * Status change plus its log row, guarded on the status we read.
   *
   * `updateMany` with `availabilityStatus` in the WHERE clause is the guard: a
   * sweep and a manual toggle racing each other produce exactly one winner, and
   * the loser gets null rather than silently overwriting the other.
   */
  async changeStatus(params: {
    expertProfileId: string;
    expectedStatus: AvailabilityStatus;
    toStatus: AvailabilityStatus;
    source: AvailabilityChangeSource;
    now: Date;
    changedByUserId?: string | null;
  }): Promise<ExpertPresenceRecord | null> {
    const updated = await this.db.expertProfile.updateMany({
      where: { id: params.expertProfileId, availabilityStatus: params.expectedStatus },
      data: {
        availabilityStatus: params.toStatus,
        ...(params.toStatus === "AVAILABLE" ? { lastAvailableAt: params.now } : {}),
      },
    });
    if (updated.count === 0) return null;

    await this.db.expertAvailabilityLog.create({
      data: {
        expertProfileId: params.expertProfileId,
        fromStatus: params.expectedStatus,
        toStatus: params.toStatus,
        source: params.source,
        changedByUserId: params.changedByUserId ?? null,
      },
    });

    return this.findPresence(params.expertProfileId);
  }

  /**
   * Requirement 5, at the storage layer.
   *
   * Writes `lastHeartbeatAt` and nothing else. There is deliberately no branch
   * here that could set `availabilityStatus` — a heartbeat can never resurrect
   * a swept expert, however the caller behaves.
   */
  async touchHeartbeat(expertProfileId: string, now: Date): Promise<Date> {
    await this.db.expertProfile.update({
      where: { id: expertProfileId },
      data: { lastHeartbeatAt: now },
    });
    return now;
  }

  async findStalePresence(params: {
    staleBefore: Date;
    limit: number;
  }): Promise<readonly ExpertPresenceRecord[]> {
    const rows = await this.db.expertProfile.findMany({
      where: {
        // AVAILABLE only, deliberately — not ON_OFFER.
        //
        // The state machine permits ON_OFFER → OFFLINE on HEARTBEAT_TIMEOUT, but
        // taking that edge here would abandon an open offer with nothing to
        // re-dispatch the request. It is moot in practice anyway: the offer
        // window is 60s and the stale window 180s, so an absent expert times out
        // of the offer long before presence goes stale. Phase 5 owns that edge,
        // once it can release the request in the same breath.
        availabilityStatus: "AVAILABLE",
        OR: [{ lastHeartbeatAt: null }, { lastHeartbeatAt: { lt: params.staleBefore } }],
      },
      orderBy: { lastHeartbeatAt: "asc" },
      take: params.limit,
      select: {
        id: true,
        userId: true,
        availabilityStatus: true,
        lastHeartbeatAt: true,
        lastAvailableAt: true,
        lastAssignedAt: true,
        lastSessionCompletedAt: true,
      },
    });
    return rows.map((row) => ({
      expertProfileId: row.id,
      userId: row.userId,
      availabilityStatus: row.availabilityStatus,
      lastHeartbeatAt: row.lastHeartbeatAt,
      lastAvailableAt: row.lastAvailableAt,
      lastAssignedAt: row.lastAssignedAt,
      lastSessionCompletedAt: row.lastSessionCompletedAt,
    }));
  }

  async listAvailabilityLog(params: {
    expertProfileId: string;
    limit: number;
  }): Promise<readonly AvailabilityLogEntry[]> {
    const rows = await this.db.expertAvailabilityLog.findMany({
      where: { expertProfileId: params.expertProfileId },
      orderBy: { createdAt: "desc" },
      take: params.limit,
    });
    return rows.map((row) => ({
      id: row.id,
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      source: row.source,
      changedByUserId: row.changedByUserId,
      createdAt: row.createdAt,
    }));
  }
}

// ── Skills ───────────────────────────────────────────────────────────────────

type SkillRow = {
  id: string;
  skillId: string;
  proficiencyLevel: ProficiencyLevel;
  yearsExperience: number;
  verified: boolean;
  verifiedAt: Date | null;
  verifiedByUserId: string | null;
  skill: { slug: string; name: string; category: { slug: string } };
};

const SKILL_INCLUDE = {
  skill: { select: { slug: true, name: true, category: { select: { slug: true } } } },
} as const;

function toSkillRecord(row: SkillRow): ExpertSkillRecord {
  return {
    id: row.id,
    skillId: row.skillId,
    slug: row.skill.slug,
    name: row.skill.name,
    categorySlug: row.skill.category.slug,
    proficiencyLevel: row.proficiencyLevel,
    yearsExperience: row.yearsExperience,
    verified: row.verified,
    verifiedAt: row.verifiedAt,
    verifiedByUserId: row.verifiedByUserId,
  };
}

export class PrismaExpertSkillRepository implements ExpertSkillRepository {
  constructor(private readonly db: Db) {}

  async listForExpert(expertProfileId: string): Promise<readonly ExpertSkillRecord[]> {
    const rows = await this.db.expertSkill.findMany({
      where: { expertProfileId },
      orderBy: [{ proficiencyLevel: "desc" }, { yearsExperience: "desc" }],
      include: SKILL_INCLUDE,
    });
    return rows.map((row) => toSkillRecord(row as SkillRow));
  }

  /**
   * Upsert of a self-declared skill.
   *
   * Note what the update branch writes: `verified: false` and both verification
   * fields cleared. The claim being vouched for has changed, so the old vouch no
   * longer applies — and there is no code path here that could leave an
   * unverified claim wearing a verified badge.
   */
  async declare(params: {
    expertProfileId: string;
    declaration: ExpertSkillDeclaration;
    now: Date;
  }): Promise<ExpertSkillRecord> {
    const row = await this.db.expertSkill.upsert({
      where: {
        expertProfileId_skillId: {
          expertProfileId: params.expertProfileId,
          skillId: params.declaration.skillId,
        },
      },
      create: {
        expertProfileId: params.expertProfileId,
        skillId: params.declaration.skillId,
        proficiencyLevel: params.declaration.proficiencyLevel,
        yearsExperience: params.declaration.yearsExperience,
        verified: false,
      },
      update: {
        proficiencyLevel: params.declaration.proficiencyLevel,
        yearsExperience: params.declaration.yearsExperience,
        verified: false,
        verifiedAt: null,
        verifiedByUserId: null,
      },
      include: SKILL_INCLUDE,
    });
    return toSkillRecord(row as SkillRow);
  }

  async remove(params: { expertProfileId: string; skillId: string }): Promise<void> {
    await this.db.expertSkill.deleteMany({
      where: { expertProfileId: params.expertProfileId, skillId: params.skillId },
    });
  }

  /** The only write path that can set `verified` to true. Admin-gated upstream. */
  async setVerified(params: {
    expertProfileId: string;
    skillId: string;
    verified: boolean;
    adminUserId: string;
    now: Date;
  }): Promise<ExpertSkillRecord> {
    const row = await this.db.expertSkill.update({
      where: {
        expertProfileId_skillId: {
          expertProfileId: params.expertProfileId,
          skillId: params.skillId,
        },
      },
      data: {
        verified: params.verified,
        verifiedAt: params.verified ? params.now : null,
        verifiedByUserId: params.verified ? params.adminUserId : null,
      },
      include: SKILL_INCLUDE,
    });
    return toSkillRecord(row as SkillRow);
  }
}

// ── Profile editing ──────────────────────────────────────────────────────────

export class PrismaExpertProfileRepository implements ExpertProfileRepository {
  constructor(private readonly db: Db) {}

  /**
   * Writes only the fields present on `ExpertProfileEdit`.
   *
   * The domain has already filtered to the allowlist; building the update
   * explicitly here means a second, independent barrier rather than spreading
   * an object whose shape we are trusting (requirement 8).
   */
  async applyEdit(params: {
    expertProfileId: string;
    edit: ExpertProfileEdit;
    now: Date;
  }): Promise<void> {
    const { edit } = params;
    const data: Record<string, unknown> = {};

    if (edit.country !== undefined) data.country = edit.country;
    if (edit.timezone !== undefined) data.timezone = edit.timezone;
    if (edit.yearsExperience !== undefined) data.yearsExperience = edit.yearsExperience;
    if (edit.professionalSummary !== undefined) {
      data.professionalSummary = edit.professionalSummary;
    }
    if (edit.languages !== undefined) data.languages = { set: [...edit.languages] };
    if (edit.certifications !== undefined) data.certifications = { set: [...edit.certifications] };
    if (edit.linkedinUrl !== undefined) data.linkedinUrl = edit.linkedinUrl || null;
    if (edit.githubUrl !== undefined) data.githubUrl = edit.githubUrl || null;
    if (edit.employmentStatus !== undefined) data.employmentStatus = edit.employmentStatus;

    if (Object.keys(data).length === 0) return;

    await this.db.expertProfile.update({ where: { id: params.expertProfileId }, data });
  }
}
