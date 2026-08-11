import type { PhotoModerationStatus } from "@sfx/contracts";

export interface ExpertPhotoRecord {
  readonly id: string;
  readonly expertProfileId: string;
  readonly storageKey: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly status: PhotoModerationStatus;
  readonly reviewNote: string | null;
  readonly uploadedAt: Date | null;
  readonly reviewedAt: Date | null;
  readonly createdAt: Date;
}

export interface ExpertPhotoRepository {
  create(input: {
    readonly expertProfileId: string;
    readonly storageKey: string;
    readonly contentType: string;
    readonly sizeBytes: number;
  }): Promise<ExpertPhotoRecord>;

  findById(id: string): Promise<ExpertPhotoRecord | null>;
  findByStorageKey(storageKey: string): Promise<ExpertPhotoRecord | null>;

  /** The expert's own current photo, whatever its state — including rejected. */
  findCurrentForExpert(expertProfileId: string): Promise<ExpertPhotoRecord | null>;

  /**
   * The approved photo, or null. Separate from `findCurrentForExpert` on purpose:
   * every customer-facing caller uses this one, so "customers only see approved"
   * is a property of the query rather than a filter someone must remember.
   */
  findApprovedForExpert(expertProfileId: string): Promise<ExpertPhotoRecord | null>;

  /** Approved photos for several experts at once — for the shortlist cards. */
  findApprovedForExperts(
    expertProfileIds: readonly string[],
  ): Promise<ReadonlyMap<string, ExpertPhotoRecord>>;

  markUploaded(params: {
    readonly id: string;
    readonly sizeBytes: number;
    readonly uploadedAt: Date;
  }): Promise<void>;

  decide(params: {
    readonly id: string;
    readonly status: "APPROVED" | "REJECTED";
    readonly reviewedByUserId: string;
    readonly reviewedAt: Date;
    readonly reviewNote: string | null;
  }): Promise<ExpertPhotoRecord>;

  /**
   * Supersedes every non-REPLACED photo for an expert.
   *
   * Rows are kept rather than deleted: an expert who swaps their photo leaves an
   * auditable trail of what customers were shown and when, which is exactly what
   * moderation exists to produce.
   */
  supersedeAllForExpert(params: {
    readonly expertProfileId: string;
    readonly exceptId?: string;
  }): Promise<number>;

  listPendingReview(limit: number): Promise<readonly ExpertPhotoRecord[]>;
}
