import type { AvailabilityStatus, ProficiencyLevel } from "@sfx/contracts";
import type {
  AvailabilityLogEntry,
  ExpertAvailabilityRepository,
  ExpertPresenceRecord,
  ExpertProfileEdit,
  ExpertProfileRepository,
  ExpertSkillDeclaration,
  ExpertSkillRecord,
  ExpertSkillRepository,
} from "../ports/expert-repositories.js";
import type { Logger } from "../ports/logger.js";
import type { AvailabilityChangeSource } from "./availability.js";

/**
 * In-memory doubles for the Phase 4 ports.
 *
 * Kept in `src` so it typechecks against the ports on every build. The fakes
 * model the two behaviours that carry the phase's guarantees:
 *
 * - `changeStatus` honours `expectedStatus`, so a sweep racing a manual toggle
 *   produces one winner rather than both succeeding.
 * - `touchHeartbeat` writes only the timestamp. A fake that also nudged the
 *   status would make the sticky-sweep test pass for the wrong reason.
 */

export class FakeAvailabilityRepository implements ExpertAvailabilityRepository {
  readonly presence = new Map<string, ExpertPresenceRecord>();
  readonly log: Array<AvailabilityLogEntry & { expertProfileId: string }> = [];

  seed(record: Partial<ExpertPresenceRecord> & { expertProfileId: string; userId: string }): void {
    this.presence.set(record.expertProfileId, {
      availabilityStatus: "OFFLINE",
      lastHeartbeatAt: null,
      lastAvailableAt: null,
      lastAssignedAt: null,
      lastSessionCompletedAt: null,
      ...record,
    });
  }

  async findPresence(expertProfileId: string): Promise<ExpertPresenceRecord | null> {
    return this.presence.get(expertProfileId) ?? null;
  }

  async changeStatus(params: {
    expertProfileId: string;
    expectedStatus: AvailabilityStatus;
    toStatus: AvailabilityStatus;
    source: AvailabilityChangeSource;
    now: Date;
    changedByUserId?: string | null;
  }): Promise<ExpertPresenceRecord | null> {
    const current = this.presence.get(params.expertProfileId);
    // Optimistic guard, exactly as the SQL does.
    if (!current || current.availabilityStatus !== params.expectedStatus) return null;

    const updated: ExpertPresenceRecord = {
      ...current,
      availabilityStatus: params.toStatus,
      ...(params.toStatus === "AVAILABLE" ? { lastAvailableAt: params.now } : {}),
    };
    this.presence.set(params.expertProfileId, updated);
    this.log.push({
      id: `log_${this.log.length + 1}`,
      expertProfileId: params.expertProfileId,
      fromStatus: current.availabilityStatus,
      toStatus: params.toStatus,
      source: params.source,
      changedByUserId: params.changedByUserId ?? null,
      createdAt: params.now,
    });
    return updated;
  }

  /** Timestamp only. Never touches status — that is the whole point. */
  async touchHeartbeat(expertProfileId: string, now: Date): Promise<Date> {
    const current = this.presence.get(expertProfileId);
    if (current) this.presence.set(expertProfileId, { ...current, lastHeartbeatAt: now });
    return now;
  }

  async findStalePresence(params: {
    staleBefore: Date;
    limit: number;
  }): Promise<readonly ExpertPresenceRecord[]> {
    return [...this.presence.values()]
      .filter(
        (record) =>
          record.availabilityStatus === "AVAILABLE" &&
          (record.lastHeartbeatAt === null || record.lastHeartbeatAt < params.staleBefore),
      )
      .slice(0, params.limit);
  }

  async listAvailabilityLog(params: {
    expertProfileId: string;
    limit: number;
  }): Promise<readonly AvailabilityLogEntry[]> {
    return this.log
      .filter((entry) => entry.expertProfileId === params.expertProfileId)
      .slice(-params.limit)
      .reverse();
  }
}

export class FakeExpertSkillRepository implements ExpertSkillRepository {
  readonly rows = new Map<string, ExpertSkillRecord[]>();

  private catalogue: Record<string, { slug: string; name: string; categorySlug: string }> = {
    sk_apex: { slug: "apex", name: "Apex", categorySlug: "salesforce-development" },
    sk_lwc: {
      slug: "lwc",
      name: "Lightning Web Components",
      categorySlug: "salesforce-development",
    },
    sk_flow: { slug: "flow", name: "Flow", categorySlug: "salesforce-configuration" },
    sk_cpq: {
      slug: "revenue-cloud-cpq",
      name: "Revenue Cloud / CPQ",
      categorySlug: "salesforce-clouds",
    },
  };

  async listForExpert(expertProfileId: string): Promise<readonly ExpertSkillRecord[]> {
    return this.rows.get(expertProfileId) ?? [];
  }

  async declare(params: {
    expertProfileId: string;
    declaration: ExpertSkillDeclaration;
    now: Date;
  }): Promise<ExpertSkillRecord> {
    const list = this.rows.get(params.expertProfileId) ?? [];
    const meta = this.catalogue[params.declaration.skillId] ?? {
      slug: params.declaration.skillId,
      name: params.declaration.skillId,
      categorySlug: "salesforce-development",
    };

    const existingIndex = list.findIndex((row) => row.skillId === params.declaration.skillId);
    const record: ExpertSkillRecord = {
      id: existingIndex >= 0 ? list[existingIndex]!.id : `es_${list.length + 1}`,
      skillId: params.declaration.skillId,
      slug: meta.slug,
      name: meta.name,
      categorySlug: meta.categorySlug,
      proficiencyLevel: params.declaration.proficiencyLevel,
      yearsExperience: params.declaration.yearsExperience,
      // Re-declaring clears verification: the claim being vouched for changed.
      verified: false,
      verifiedAt: null,
      verifiedByUserId: null,
    };

    if (existingIndex >= 0) list[existingIndex] = record;
    else list.push(record);
    this.rows.set(params.expertProfileId, list);
    return record;
  }

  async remove(params: { expertProfileId: string; skillId: string }): Promise<void> {
    const list = this.rows.get(params.expertProfileId) ?? [];
    this.rows.set(
      params.expertProfileId,
      list.filter((row) => row.skillId !== params.skillId),
    );
  }

  async setVerified(params: {
    expertProfileId: string;
    skillId: string;
    verified: boolean;
    adminUserId: string;
    now: Date;
  }): Promise<ExpertSkillRecord> {
    const list = this.rows.get(params.expertProfileId) ?? [];
    const index = list.findIndex((row) => row.skillId === params.skillId);
    if (index < 0) throw new Error(`Expert has not declared ${params.skillId}`);

    const updated: ExpertSkillRecord = {
      ...list[index]!,
      verified: params.verified,
      verifiedAt: params.verified ? params.now : null,
      verifiedByUserId: params.verified ? params.adminUserId : null,
    };
    list[index] = updated;
    this.rows.set(params.expertProfileId, list);
    return updated;
  }

  /** Test helper for seeding a pre-verified skill. */
  seedVerified(expertProfileId: string, skillId: string, level: ProficiencyLevel): void {
    const list = this.rows.get(expertProfileId) ?? [];
    const meta = this.catalogue[skillId]!;
    list.push({
      id: `es_seed_${list.length + 1}`,
      skillId,
      slug: meta.slug,
      name: meta.name,
      categorySlug: meta.categorySlug,
      proficiencyLevel: level,
      yearsExperience: 5,
      verified: true,
      verifiedAt: new Date(0),
      verifiedByUserId: "admin_seed",
    });
    this.rows.set(expertProfileId, list);
  }
}

export class FakeExpertProfileRepository implements ExpertProfileRepository {
  readonly edits: Array<{ expertProfileId: string; edit: ExpertProfileEdit }> = [];

  async applyEdit(params: {
    expertProfileId: string;
    edit: ExpertProfileEdit;
    now: Date;
  }): Promise<void> {
    this.edits.push({ expertProfileId: params.expertProfileId, edit: params.edit });
  }
}

export class RecordingLogger implements Logger {
  readonly lines: Array<{ level: string; message: string; context?: Record<string, unknown> }> = [];
  debug(message: string, context?: Record<string, unknown>): void {
    this.lines.push({ level: "debug", message, ...(context ? { context } : {}) });
  }
  info(message: string, context?: Record<string, unknown>): void {
    this.lines.push({ level: "info", message, ...(context ? { context } : {}) });
  }
  warn(message: string, context?: Record<string, unknown>): void {
    this.lines.push({ level: "warn", message, ...(context ? { context } : {}) });
  }
  error(message: string, context?: Record<string, unknown>): void {
    this.lines.push({ level: "error", message, ...(context ? { context } : {}) });
  }
  child(): Logger {
    return this;
  }
}
