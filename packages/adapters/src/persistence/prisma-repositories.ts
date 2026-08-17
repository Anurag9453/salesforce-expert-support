import type { ExpertStatus, UserRole } from "@sfx/contracts";
import type { PrismaClient, PrismaTransactionClient } from "@sfx/db";
import type {
  AuditEntry,
  AuditLogEntryRecord,
  AuditLogRepository,
  ExpertApplicationDraft,
  ExpertApplicationRecord,
  ExpertApplicationRepository,
  Repositories,
  UnitOfWork,
  UserRecord,
  UserRepository,
} from "@sfx/domain";
import { ConflictError } from "@sfx/domain";

/**
 * Prisma implementations of the domain's repository ports.
 *
 * Everything Prisma-shaped stops here. The domain sees only the record types it
 * declared, so a schema rename is a change in this file rather than a change
 * rippling through business logic.
 */

type Db = PrismaClient | PrismaTransactionClient;

/**
 * Prisma's unique-constraint code, detected structurally rather than by
 * importing `Prisma.PrismaClientKnownRequestError` — the class identity differs
 * between the generated client and a bundled copy, so `instanceof` is unreliable
 * across the Next.js/worker boundary.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

// ── Mapping ──────────────────────────────────────────────────────────────────

type PrismaUser = {
  id: string;
  email: string;
  name: string;
  roles: UserRole[];
  status: "ACTIVE" | "SUSPENDED" | "DELETED";
  createdAt: Date;
};

function toUserRecord(row: PrismaUser): UserRecord {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    roles: row.roles,
    status: row.status,
    createdAt: row.createdAt,
  };
}

type PrismaExpert = {
  id: string;
  userId: string;
  status: ExpertStatus;
  statusChangedAt: Date;
  submittedAt: Date | null;
  reviewedByUserId: string | null;
  reviewNotes: string | null;
  country: string | null;
  timezone: string | null;
  yearsExperience: number | null;
  professionalSummary: string | null;
  languages: string[];
  certifications: string[];
  linkedinUrl: string | null;
  githubUrl: string | null;
  employmentStatus: string | null;
  phone: string | null;
  trailheadUrl: string | null;
  verifiedCertifications: string[];
  certificationsVerifiedAt: Date | null;
  certificationsVerifiedBy: string | null;
  termsAcceptedAt: Date | null;
  confidentialityAcceptedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function toExpertRecord(row: PrismaExpert): ExpertApplicationRecord {
  return { ...row };
}

// ── Users ────────────────────────────────────────────────────────────────────

export class PrismaUserRepository implements UserRepository {
  constructor(private readonly db: Db) {}

  async findById(id: string): Promise<UserRecord | null> {
    const row = await this.db.user.findUnique({ where: { id } });
    return row ? toUserRecord(row) : null;
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const row = await this.db.user.findUnique({ where: { email: email.toLowerCase() } });
    return row ? toUserRecord(row) : null;
  }

  /**
   * Idempotent by construction: read, and only write when the role is genuinely
   * absent. A customer who clicks "become an expert" twice ends up with
   * `[CUSTOMER, EXPERT]`, not `[CUSTOMER, EXPERT, EXPERT]`.
   */
  async addRole(userId: string, role: UserRole): Promise<UserRecord> {
    const current = await this.db.user.findUnique({ where: { id: userId } });
    if (!current) throw new Error(`Unknown user ${userId}`);
    if (current.roles.includes(role)) return toUserRecord(current);

    const updated = await this.db.user.update({
      where: { id: userId },
      data: { roles: { set: [...current.roles, role] } },
    });
    return toUserRecord(updated);
  }

  async hasCustomerProfile(userId: string): Promise<boolean> {
    const count = await this.db.customerProfile.count({ where: { userId } });
    return count > 0;
  }

  async createCustomerProfile(userId: string): Promise<void> {
    // Concurrent first requests can race here; the unique constraint on userId
    // makes the loser a no-op rather than a duplicate profile.
    await this.db.customerProfile.createMany({ data: [{ userId }], skipDuplicates: true });
  }
}

// ── Expert applications ──────────────────────────────────────────────────────

export class PrismaExpertApplicationRepository implements ExpertApplicationRepository {
  constructor(private readonly db: Db) {}

  async findByUserId(userId: string): Promise<ExpertApplicationRecord | null> {
    const row = await this.db.expertProfile.findUnique({ where: { userId } });
    return row ? toExpertRecord(row) : null;
  }

  async findById(id: string): Promise<ExpertApplicationRecord | null> {
    const row = await this.db.expertProfile.findUnique({ where: { id } });
    return row ? toExpertRecord(row) : null;
  }

  async create(userId: string): Promise<ExpertApplicationRecord> {
    try {
      const row = await this.db.expertProfile.create({ data: { userId, status: "DRAFT" } });
      return toExpertRecord(row);
    } catch (error) {
      // Translate the unique-constraint violation into a domain error so the
      // service can recover from a concurrent start. Leaking P2002 upward would
      // force the domain to know Prisma's error codes.
      if (isUniqueViolation(error)) {
        throw new ConflictError("An expert application already exists for this user.", { userId });
      }
      throw error;
    }
  }

  async updateDraft(
    id: string,
    draft: ExpertApplicationDraft,
    now: Date,
  ): Promise<ExpertApplicationRecord> {
    // Only fields the caller actually supplied are written; an absent key means
    // "unchanged", which is what makes a partial wizard save safe.
    const data: Record<string, unknown> = {};
    if (draft.country !== undefined) data.country = draft.country;
    if (draft.timezone !== undefined) data.timezone = draft.timezone;
    if (draft.yearsExperience !== undefined) data.yearsExperience = draft.yearsExperience;
    if (draft.professionalSummary !== undefined) {
      data.professionalSummary = draft.professionalSummary;
    }
    if (draft.phone !== undefined) data.phone = draft.phone;
    if (draft.trailheadUrl !== undefined) data.trailheadUrl = draft.trailheadUrl || null;
    if (draft.languages !== undefined) data.languages = { set: [...draft.languages] };
    if (draft.certifications !== undefined)
      data.certifications = { set: [...draft.certifications] };
    if (draft.linkedinUrl !== undefined) data.linkedinUrl = draft.linkedinUrl || null;
    if (draft.githubUrl !== undefined) data.githubUrl = draft.githubUrl || null;
    if (draft.employmentStatus !== undefined) data.employmentStatus = draft.employmentStatus;

    // Acceptance is a timestamp, not a boolean: WHEN someone accepted the terms
    // is the part that matters if it is ever questioned. Unticking clears it.
    if (draft.acceptTerms !== undefined) data.termsAcceptedAt = draft.acceptTerms ? now : null;
    if (draft.acceptConfidentiality !== undefined) {
      data.confidentialityAcceptedAt = draft.acceptConfidentiality ? now : null;
    }

    const row = await this.db.expertProfile.update({ where: { id }, data });
    return toExpertRecord(row);
  }

  async updateStatus(params: {
    id: string;
    status: ExpertStatus;
    now: Date;
    reviewedByUserId?: string | null;
    reviewNotes?: string | null;
    submittedAt?: Date | null;
    verifiedCertifications?: readonly string[];
    certificationsVerifiedAt?: Date;
    certificationsVerifiedBy?: string;
  }): Promise<ExpertApplicationRecord> {
    const data: Record<string, unknown> = {
      status: params.status,
      statusChangedAt: params.now,
    };
    if (params.reviewedByUserId !== undefined) data.reviewedByUserId = params.reviewedByUserId;
    if (params.reviewNotes !== undefined) data.reviewNotes = params.reviewNotes;
    if (params.submittedAt !== undefined) data.submittedAt = params.submittedAt;
    // Written only on approval, and never cleared by a later status change: what
    // a reviewer checked stays true even after the expert is suspended.
    if (params.verifiedCertifications !== undefined) {
      data.verifiedCertifications = { set: [...params.verifiedCertifications] };
    }
    if (params.certificationsVerifiedAt !== undefined) {
      data.certificationsVerifiedAt = params.certificationsVerifiedAt;
    }
    if (params.certificationsVerifiedBy !== undefined) {
      data.certificationsVerifiedBy = params.certificationsVerifiedBy;
    }

    const row = await this.db.expertProfile.update({ where: { id: params.id }, data });
    return toExpertRecord(row);
  }

  async listByStatus(params: {
    statuses: readonly ExpertStatus[];
    limit: number;
    cursor?: string;
  }): Promise<{ items: readonly ExpertApplicationRecord[]; nextCursor?: string }> {
    // Fetch one extra to determine whether another page exists, without a count.
    const rows = await this.db.expertProfile.findMany({
      where: { status: { in: [...params.statuses] } },
      // Oldest submission first: an applicant who has been waiting longest is
      // reviewed first.
      orderBy: [{ submittedAt: "asc" }, { createdAt: "asc" }],
      take: params.limit + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > params.limit;
    const page = hasMore ? rows.slice(0, params.limit) : rows;
    const nextCursor = hasMore ? page[page.length - 1]?.id : undefined;

    return {
      items: page.map(toExpertRecord),
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
  }
}

// ── Audit log ────────────────────────────────────────────────────────────────

export class PrismaAuditLogRepository implements AuditLogRepository {
  constructor(private readonly db: Db) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.db.auditLog.create({
      data: {
        actorUserId: entry.actorUserId,
        actorType: entry.actorType,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        before: (entry.before ?? undefined) as never,
        after: (entry.after ?? undefined) as never,
        ipAddress: entry.ipAddress ?? null,
      },
    });
  }

  async listForEntity(params: {
    entityType: string;
    entityId: string;
    limit: number;
  }): Promise<readonly AuditLogEntryRecord[]> {
    const rows = await this.db.auditLog.findMany({
      where: { entityType: params.entityType, entityId: params.entityId },
      orderBy: { createdAt: "desc" },
      take: params.limit,
    });
    return rows.map((row) => ({
      id: row.id,
      actorUserId: row.actorUserId,
      actorType: row.actorType,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      before: row.before as Record<string, unknown> | null,
      after: row.after as Record<string, unknown> | null,
      ipAddress: row.ipAddress,
      createdAt: row.createdAt,
    }));
  }
}

// ── Unit of work ─────────────────────────────────────────────────────────────

function buildRepositories(db: Db): Repositories {
  return {
    users: new PrismaUserRepository(db),
    expertApplications: new PrismaExpertApplicationRepository(db),
    auditLog: new PrismaAuditLogRepository(db),
  };
}

/**
 * Wraps Prisma's interactive transaction so a service can change a status and
 * write its audit row atomically — the guarantee requirement 3 depends on.
 */
export class PrismaUnitOfWork implements UnitOfWork {
  readonly users: UserRepository;
  readonly expertApplications: ExpertApplicationRepository;
  readonly auditLog: AuditLogRepository;

  constructor(private readonly prisma: PrismaClient) {
    const repos = buildRepositories(prisma);
    this.users = repos.users;
    this.expertApplications = repos.expertApplications;
    this.auditLog = repos.auditLog;
  }

  async transaction<T>(fn: (repos: Repositories) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => fn(buildRepositories(tx)));
  }
}
