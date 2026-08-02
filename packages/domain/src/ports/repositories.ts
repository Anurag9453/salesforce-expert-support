import type { ExpertStatus, UserRole } from "@sfx/contracts";

/**
 * Persistence, as interfaces.
 *
 * The domain never sees Prisma. These describe what it needs, in its own terms;
 * `packages/adapters` supplies the implementation.
 */

// ── Read models ──────────────────────────────────────────────────────────────

export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly roles: readonly UserRole[];
  readonly status: "ACTIVE" | "SUSPENDED" | "DELETED";
  readonly createdAt: Date;
}

export interface ExpertApplicationRecord {
  readonly id: string;
  readonly userId: string;
  readonly status: ExpertStatus;
  readonly statusChangedAt: Date;
  readonly submittedAt: Date | null;
  readonly reviewedByUserId: string | null;
  readonly reviewNotes: string | null;

  readonly country: string | null;
  readonly timezone: string | null;
  readonly yearsExperience: number | null;
  readonly professionalSummary: string | null;
  readonly languages: readonly string[];
  readonly certifications: readonly string[];
  readonly linkedinUrl: string | null;
  readonly githubUrl: string | null;
  readonly employmentStatus: string | null;
  readonly termsAcceptedAt: Date | null;
  readonly confidentialityAcceptedAt: Date | null;

  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ExpertApplicationDraft {
  readonly country?: string | null;
  readonly timezone?: string | null;
  readonly yearsExperience?: number | null;
  readonly professionalSummary?: string | null;
  readonly languages?: readonly string[];
  readonly certifications?: readonly string[];
  readonly linkedinUrl?: string | null;
  readonly githubUrl?: string | null;
  readonly employmentStatus?: string | null;
  readonly acceptTerms?: boolean;
  readonly acceptConfidentiality?: boolean;
}

/**
 * Requirement 3 — the audit record for an administrative decision.
 *
 * Who, when, and which transition. Written in the same transaction as the
 * status change, so an approval can never exist without its audit row.
 */
export interface AuditEntry {
  readonly actorUserId: string | null;
  readonly actorType: "SYSTEM" | "CUSTOMER" | "EXPERT" | "ADMIN";
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly ipAddress?: string | null;
}

export interface AuditLogEntryRecord extends AuditEntry {
  readonly id: string;
  readonly createdAt: Date;
}

// ── Repositories ─────────────────────────────────────────────────────────────

export interface UserRepository {
  findById(id: string): Promise<UserRecord | null>;
  findByEmail(email: string): Promise<UserRecord | null>;
  /** Idempotent: adding a role the user already holds is a no-op. */
  addRole(userId: string, role: UserRole): Promise<UserRecord>;
  hasCustomerProfile(userId: string): Promise<boolean>;
  createCustomerProfile(userId: string): Promise<void>;
}

export interface ExpertApplicationRepository {
  findByUserId(userId: string): Promise<ExpertApplicationRecord | null>;
  findById(id: string): Promise<ExpertApplicationRecord | null>;
  /**
   * One application per user, enforced by a unique constraint on userId.
   *
   * Implementations MUST throw `ConflictError` when that constraint is
   * violated, so the service can turn a concurrent start into an idempotent
   * success instead of a 500. An implementation that lets a duplicate through
   * is a bug, not a lenient variant.
   */
  create(userId: string): Promise<ExpertApplicationRecord>;
  updateDraft(
    id: string,
    draft: ExpertApplicationDraft,
    now: Date,
  ): Promise<ExpertApplicationRecord>;
  updateStatus(params: {
    readonly id: string;
    readonly status: ExpertStatus;
    readonly now: Date;
    readonly reviewedByUserId?: string | null;
    readonly reviewNotes?: string | null;
    readonly submittedAt?: Date | null;
  }): Promise<ExpertApplicationRecord>;
  listByStatus(params: {
    readonly statuses: readonly ExpertStatus[];
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<{ readonly items: readonly ExpertApplicationRecord[]; readonly nextCursor?: string }>;
}

export interface AuditLogRepository {
  record(entry: AuditEntry): Promise<void>;
  listForEntity(params: {
    readonly entityType: string;
    readonly entityId: string;
    readonly limit: number;
  }): Promise<readonly AuditLogEntryRecord[]>;
}

export interface Repositories {
  readonly users: UserRepository;
  readonly expertApplications: ExpertApplicationRepository;
  readonly auditLog: AuditLogRepository;
}

/**
 * Atomicity across repositories.
 *
 * Approving an expert changes a status AND writes an audit row. Those must
 * commit together or not at all — an approval with no record of who approved it
 * is exactly the gap requirement 3 exists to close.
 */
export interface UnitOfWork extends Repositories {
  transaction<T>(fn: (repos: Repositories) => Promise<T>): Promise<T>;
}
