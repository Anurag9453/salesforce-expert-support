import type {
  AvailabilityChangeSource,
  AvailabilityStatus,
  ProficiencyLevel,
} from "@sfx/contracts";

/**
 * Persistence for expert availability, presence, and skills.
 *
 * As with every other port: the domain describes what it needs and never sees
 * Prisma.
 */

export interface ExpertPresenceRecord {
  readonly expertProfileId: string;
  readonly userId: string;
  readonly availabilityStatus: AvailabilityStatus;
  readonly lastHeartbeatAt: Date | null;
  readonly lastAvailableAt: Date | null;
  readonly lastAssignedAt: Date | null;
  readonly lastSessionCompletedAt: Date | null;
}

export interface AvailabilityLogEntry {
  readonly id: string;
  readonly fromStatus: AvailabilityStatus | null;
  readonly toStatus: AvailabilityStatus;
  readonly source: AvailabilityChangeSource;
  readonly changedByUserId: string | null;
  readonly createdAt: Date;
}

export interface ExpertAvailabilityRepository {
  findPresence(expertProfileId: string): Promise<ExpertPresenceRecord | null>;

  /**
   * Applies the status change and writes its log row together.
   *
   * `expectedStatus` is the optimistic guard: a concurrent sweep and a manual
   * toggle must not both succeed. Returns null when the row has already moved,
   * which the caller treats as "someone else got there first" rather than an
   * error.
   */
  changeStatus(params: {
    readonly expertProfileId: string;
    readonly expectedStatus: AvailabilityStatus;
    readonly toStatus: AvailabilityStatus;
    readonly source: AvailabilityChangeSource;
    readonly now: Date;
    readonly changedByUserId?: string | null;
  }): Promise<ExpertPresenceRecord | null>;

  /**
   * Records presence. MUST NOT change `availabilityStatus`.
   *
   * This is what makes the sweep sticky (requirement 5): a heartbeat arriving
   * after a sweep updates the timestamp and leaves the expert OFFLINE. Only an
   * explicit toggle brings them back.
   */
  touchHeartbeat(expertProfileId: string, now: Date): Promise<Date>;

  /** Experts claiming to be AVAILABLE whose presence has gone stale. */
  findStalePresence(params: {
    readonly staleBefore: Date;
    readonly limit: number;
  }): Promise<readonly ExpertPresenceRecord[]>;

  listAvailabilityLog(params: {
    readonly expertProfileId: string;
    readonly limit: number;
  }): Promise<readonly AvailabilityLogEntry[]>;
}

// ── Skills ───────────────────────────────────────────────────────────────────

export interface ExpertSkillRecord {
  readonly id: string;
  readonly skillId: string;
  readonly slug: string;
  readonly name: string;
  readonly categorySlug: string;
  readonly proficiencyLevel: ProficiencyLevel;
  readonly yearsExperience: number;
  /**
   * Admin-set only (requirement 2). No self-service route writes this — the
   * expert-facing repository methods below cannot express it.
   */
  readonly verified: boolean;
  readonly verifiedAt: Date | null;
  readonly verifiedByUserId: string | null;
}

/**
 * What an expert may set about their own skill.
 *
 * `verified` is structurally absent rather than ignored: an expert-supplied
 * object has no field through which to claim it, so no future handler can
 * accidentally pass one through.
 */
export interface ExpertSkillDeclaration {
  readonly skillId: string;
  readonly proficiencyLevel: ProficiencyLevel;
  readonly yearsExperience: number;
}

export interface ExpertSkillRepository {
  listForExpert(expertProfileId: string): Promise<readonly ExpertSkillRecord[]>;

  /**
   * Upsert of a self-declared skill.
   *
   * Re-declaring an already-verified skill **clears the verification**: the
   * claim being vouched for has changed, so the old vouch no longer applies.
   * Silently keeping it would let an expert launder an unverified claim through
   * a verified one.
   */
  declare(params: {
    readonly expertProfileId: string;
    readonly declaration: ExpertSkillDeclaration;
    readonly now: Date;
  }): Promise<ExpertSkillRecord>;

  remove(params: { readonly expertProfileId: string; readonly skillId: string }): Promise<void>;

  /** Admin-only. The single write path for `verified`. */
  setVerified(params: {
    readonly expertProfileId: string;
    readonly skillId: string;
    readonly verified: boolean;
    readonly adminUserId: string;
    readonly now: Date;
  }): Promise<ExpertSkillRecord>;
}

// ── Profile editing ──────────────────────────────────────────────────────────

/**
 * Fields an approved expert may change about themselves (requirement 8).
 *
 * An allowlist, not a denylist. Status, verification, review notes and metrics
 * have no representation here at all, so adding a new administrative column
 * cannot accidentally become self-editable by omission.
 */
export interface ExpertProfileEdit {
  readonly country?: string;
  readonly timezone?: string;
  readonly yearsExperience?: number;
  readonly professionalSummary?: string;
  readonly languages?: readonly string[];
  readonly certifications?: readonly string[];
  readonly linkedinUrl?: string | null;
  readonly githubUrl?: string | null;
  readonly employmentStatus?: string | null;
}

export interface ExpertProfileRepository {
  applyEdit(params: {
    readonly expertProfileId: string;
    readonly edit: ExpertProfileEdit;
    readonly now: Date;
  }): Promise<void>;
}
