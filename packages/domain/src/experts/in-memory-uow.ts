import type { ExpertStatus, UserRole } from "@sfx/contracts";
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
} from "../ports/repositories.js";
import { ConflictError } from "../shared/errors.js";

/**
 * In-memory UnitOfWork for tests.
 *
 * Exists because the services are where authorization, the lifecycle, and the
 * audit writes meet — the interesting behaviour is the interaction, and testing
 * that against a real database would be slow enough that we would write fewer
 * cases. Kept in src (not a test file) so the fake typechecks against the ports
 * on every build: if a port gains a method, this fails to compile.
 */

class InMemoryUserRepository implements UserRepository {
  constructor(
    private readonly users: Map<string, UserRecord>,
    private readonly customerProfiles: Set<string>,
  ) {}

  async findById(id: string): Promise<UserRecord | null> {
    return this.users.get(id) ?? null;
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    return [...this.users.values()].find((u) => u.email === email) ?? null;
  }

  async addRole(userId: string, role: UserRole): Promise<UserRecord> {
    const user = this.users.get(userId);
    if (!user) throw new Error(`Unknown user ${userId}`);
    if (user.roles.includes(role)) return user;
    const updated: UserRecord = { ...user, roles: [...user.roles, role] };
    this.users.set(userId, updated);
    return updated;
  }

  async hasCustomerProfile(userId: string): Promise<boolean> {
    return this.customerProfiles.has(userId);
  }

  async createCustomerProfile(userId: string): Promise<void> {
    this.customerProfiles.add(userId);
  }
}

class InMemoryExpertRepository implements ExpertApplicationRepository {
  constructor(private readonly applications: Map<string, ExpertApplicationRecord>) {}

  async findByUserId(userId: string): Promise<ExpertApplicationRecord | null> {
    return [...this.applications.values()].find((a) => a.userId === userId) ?? null;
  }

  async findById(id: string): Promise<ExpertApplicationRecord | null> {
    return this.applications.get(id) ?? null;
  }

  async create(userId: string): Promise<ExpertApplicationRecord> {
    // Models the unique constraint on userId. Without it this fake would let a
    // race through that the real database rejects — and a fake that is more
    // permissive than production hides exactly the bugs it should surface.
    const clash = [...this.applications.values()].find((a) => a.userId === userId);
    if (clash) {
      throw new ConflictError("An expert application already exists for this user.", { userId });
    }

    const now = new Date(0);
    const record: ExpertApplicationRecord = {
      id: `exp_${this.applications.size + 1}`,
      userId,
      status: "DRAFT",
      statusChangedAt: now,
      submittedAt: null,
      reviewedByUserId: null,
      reviewNotes: null,
      country: null,
      timezone: null,
      yearsExperience: null,
      professionalSummary: null,
      phone: null,
      trailheadUrl: null,
      languages: [],
      certifications: [],
      verifiedCertifications: [],
      certificationsVerifiedAt: null,
      certificationsVerifiedBy: null,
      linkedinUrl: null,
      githubUrl: null,
      employmentStatus: null,
      termsAcceptedAt: null,
      confidentialityAcceptedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.applications.set(record.id, record);
    return record;
  }

  async updateDraft(
    id: string,
    draft: ExpertApplicationDraft,
    now: Date,
  ): Promise<ExpertApplicationRecord> {
    const current = this.applications.get(id);
    if (!current) throw new Error(`Unknown application ${id}`);
    const updated: ExpertApplicationRecord = {
      ...current,
      ...(draft.country !== undefined ? { country: draft.country } : {}),
      ...(draft.timezone !== undefined ? { timezone: draft.timezone } : {}),
      ...(draft.yearsExperience !== undefined ? { yearsExperience: draft.yearsExperience } : {}),
      ...(draft.professionalSummary !== undefined
        ? { professionalSummary: draft.professionalSummary }
        : {}),
      ...(draft.phone !== undefined ? { phone: draft.phone } : {}),
      ...(draft.trailheadUrl !== undefined ? { trailheadUrl: draft.trailheadUrl || null } : {}),
      ...(draft.languages !== undefined ? { languages: [...draft.languages] } : {}),
      ...(draft.certifications !== undefined ? { certifications: [...draft.certifications] } : {}),
      ...(draft.linkedinUrl !== undefined ? { linkedinUrl: draft.linkedinUrl || null } : {}),
      ...(draft.githubUrl !== undefined ? { githubUrl: draft.githubUrl || null } : {}),
      ...(draft.employmentStatus !== undefined ? { employmentStatus: draft.employmentStatus } : {}),
      ...(draft.acceptTerms !== undefined
        ? { termsAcceptedAt: draft.acceptTerms ? now : null }
        : {}),
      ...(draft.acceptConfidentiality !== undefined
        ? { confidentialityAcceptedAt: draft.acceptConfidentiality ? now : null }
        : {}),
      updatedAt: now,
    };
    this.applications.set(id, updated);
    return updated;
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
    const current = this.applications.get(params.id);
    if (!current) throw new Error(`Unknown application ${params.id}`);
    const updated: ExpertApplicationRecord = {
      ...current,
      status: params.status,
      statusChangedAt: params.now,
      ...(params.reviewedByUserId !== undefined
        ? { reviewedByUserId: params.reviewedByUserId }
        : {}),
      ...(params.reviewNotes !== undefined ? { reviewNotes: params.reviewNotes } : {}),
      ...(params.submittedAt !== undefined ? { submittedAt: params.submittedAt } : {}),
      ...(params.verifiedCertifications !== undefined
        ? { verifiedCertifications: [...params.verifiedCertifications] }
        : {}),
      ...(params.certificationsVerifiedAt !== undefined
        ? { certificationsVerifiedAt: params.certificationsVerifiedAt }
        : {}),
      ...(params.certificationsVerifiedBy !== undefined
        ? { certificationsVerifiedBy: params.certificationsVerifiedBy }
        : {}),
      updatedAt: params.now,
    };
    this.applications.set(params.id, updated);
    return updated;
  }

  async listByStatus(params: {
    statuses: readonly ExpertStatus[];
    limit: number;
    cursor?: string;
  }): Promise<{ items: readonly ExpertApplicationRecord[]; nextCursor?: string }> {
    const items = [...this.applications.values()]
      .filter((a) => params.statuses.includes(a.status))
      .sort((a, b) => (a.submittedAt?.getTime() ?? 0) - (b.submittedAt?.getTime() ?? 0))
      .slice(0, params.limit);
    return { items };
  }
}

class InMemoryAuditLogRepository implements AuditLogRepository {
  constructor(private readonly entries: AuditLogEntryRecord[]) {}

  async record(entry: AuditEntry): Promise<void> {
    this.entries.push({
      ...entry,
      id: `audit_${this.entries.length + 1}`,
      createdAt: new Date(this.entries.length),
    });
  }

  async listForEntity(params: {
    entityType: string;
    entityId: string;
    limit: number;
  }): Promise<readonly AuditLogEntryRecord[]> {
    return this.entries
      .filter((e) => e.entityType === params.entityType && e.entityId === params.entityId)
      .reverse()
      .slice(0, params.limit);
  }
}

export class InMemoryUnitOfWork implements UnitOfWork {
  readonly userRows = new Map<string, UserRecord>();
  readonly applicationRows = new Map<string, ExpertApplicationRecord>();
  readonly customerProfileIds = new Set<string>();
  readonly auditEntries: AuditLogEntryRecord[] = [];

  /** Set to make `transaction` throw after the callback, to test rollback. */
  failCommit = false;

  readonly users = new InMemoryUserRepository(this.userRows, this.customerProfileIds);
  readonly expertApplications = new InMemoryExpertRepository(this.applicationRows);
  readonly auditLog = new InMemoryAuditLogRepository(this.auditEntries);

  seedUser(user: Partial<UserRecord> & { id: string }): UserRecord {
    const record: UserRecord = {
      email: `${user.id}@example.com`,
      name: user.id,
      roles: ["CUSTOMER"],
      status: "ACTIVE",
      createdAt: new Date(0),
      ...user,
    };
    this.userRows.set(record.id, record);
    return record;
  }

  /**
   * Snapshots state before the callback and restores it on failure, so a test
   * can assert that a failed decision leaves neither a status change nor a
   * stray audit row.
   */
  async transaction<T>(fn: (repos: Repositories) => Promise<T>): Promise<T> {
    const userSnapshot = new Map(this.userRows);
    const applicationSnapshot = new Map(this.applicationRows);
    const auditLength = this.auditEntries.length;

    try {
      const result = await fn(this);
      if (this.failCommit) throw new Error("simulated commit failure");
      return result;
    } catch (error) {
      this.userRows.clear();
      for (const [k, v] of userSnapshot) this.userRows.set(k, v);
      this.applicationRows.clear();
      for (const [k, v] of applicationSnapshot) this.applicationRows.set(k, v);
      this.auditEntries.length = auditLength;
      throw error;
    }
  }
}
