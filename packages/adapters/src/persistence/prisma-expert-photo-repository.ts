import { randomUUID } from "node:crypto";
import type { PrismaClient, PrismaTransactionClient } from "@sfx/db";
import type { ExpertPhotoRecord, ExpertPhotoRepository } from "@sfx/domain";

type Db = PrismaClient | PrismaTransactionClient;

type Row = {
  id: string;
  expertProfileId: string;
  storageKey: string;
  contentType: string;
  sizeBytes: number;
  status: string;
  reviewNote: string | null;
  uploadedAt: Date | null;
  reviewedAt: Date | null;
  createdAt: Date;
};

function toRecord(row: Row): ExpertPhotoRecord {
  return {
    id: row.id,
    expertProfileId: row.expertProfileId,
    storageKey: row.storageKey,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    status: row.status as ExpertPhotoRecord["status"],
    reviewNote: row.reviewNote,
    uploadedAt: row.uploadedAt,
    reviewedAt: row.reviewedAt,
    createdAt: row.createdAt,
  };
}

/**
 * Photo keys are generated server-side and never contain a user-supplied
 * filename, which removes filename-driven path traversal rather than sanitising
 * it — the same approach `buildAttachmentKey` takes.
 *
 * The extension comes from the *declared* content type, not the filename, and
 * the bytes are checked against their magic number before the row is marked
 * uploaded. So the extension is cosmetic and cannot be steered.
 */
export function buildExpertPhotoKey(expertProfileId: string, contentType: string): string {
  const extension =
    contentType === "image/png" ? ".png" : contentType === "image/webp" ? ".webp" : ".jpg";
  return `expert-photos/${expertProfileId}/${randomUUID()}${extension}`;
}

export class PrismaExpertPhotoRepository implements ExpertPhotoRepository {
  constructor(private readonly db: Db) {}

  async create(input: {
    expertProfileId: string;
    storageKey: string;
    contentType: string;
    sizeBytes: number;
  }): Promise<ExpertPhotoRecord> {
    return toRecord(await this.db.expertPhoto.create({ data: input }));
  }

  async findById(id: string): Promise<ExpertPhotoRecord | null> {
    const row = await this.db.expertPhoto.findUnique({ where: { id } });
    return row ? toRecord(row) : null;
  }

  async findByStorageKey(storageKey: string): Promise<ExpertPhotoRecord | null> {
    const row = await this.db.expertPhoto.findUnique({ where: { storageKey } });
    return row ? toRecord(row) : null;
  }

  async findCurrentForExpert(expertProfileId: string): Promise<ExpertPhotoRecord | null> {
    const row = await this.db.expertPhoto.findFirst({
      where: { expertProfileId, status: { not: "REPLACED" } },
      orderBy: { createdAt: "desc" },
    });
    return row ? toRecord(row) : null;
  }

  async findApprovedForExpert(expertProfileId: string): Promise<ExpertPhotoRecord | null> {
    // The visibility rule, as a query rather than a filter someone must remember.
    const row = await this.db.expertPhoto.findFirst({
      where: { expertProfileId, status: "APPROVED" },
      orderBy: { createdAt: "desc" },
    });
    return row ? toRecord(row) : null;
  }

  async findApprovedForExperts(
    expertProfileIds: readonly string[],
  ): Promise<ReadonlyMap<string, ExpertPhotoRecord>> {
    if (expertProfileIds.length === 0) return new Map();
    const rows = await this.db.expertPhoto.findMany({
      where: { expertProfileId: { in: [...expertProfileIds] }, status: "APPROVED" },
      orderBy: { createdAt: "desc" },
    });
    const byExpert = new Map<string, ExpertPhotoRecord>();
    for (const row of rows) {
      // Newest first, so the first one seen per expert wins.
      if (!byExpert.has(row.expertProfileId)) byExpert.set(row.expertProfileId, toRecord(row));
    }
    return byExpert;
  }

  async markUploaded(params: { id: string; sizeBytes: number; uploadedAt: Date }): Promise<void> {
    await this.db.expertPhoto.update({
      where: { id: params.id },
      data: { sizeBytes: params.sizeBytes, uploadedAt: params.uploadedAt },
    });
  }

  async decide(params: {
    id: string;
    status: "APPROVED" | "REJECTED";
    reviewedByUserId: string;
    reviewedAt: Date;
    reviewNote: string | null;
  }): Promise<ExpertPhotoRecord> {
    const row = await this.db.expertPhoto.update({
      where: { id: params.id },
      data: {
        status: params.status,
        reviewedByUserId: params.reviewedByUserId,
        reviewedAt: params.reviewedAt,
        reviewNote: params.reviewNote,
      },
    });
    return toRecord(row);
  }

  async supersedeAllForExpert(params: {
    expertProfileId: string;
    exceptId?: string;
  }): Promise<number> {
    const result = await this.db.expertPhoto.updateMany({
      where: {
        expertProfileId: params.expertProfileId,
        status: { not: "REPLACED" },
        ...(params.exceptId ? { id: { not: params.exceptId } } : {}),
      },
      data: { status: "REPLACED" },
    });
    return result.count;
  }

  async listPendingReview(limit: number): Promise<readonly ExpertPhotoRecord[]> {
    const rows = await this.db.expertPhoto.findMany({
      // Only rows whose bytes actually arrived — a reserved-but-abandoned row is
      // not something a human should be asked to look at.
      where: { status: "PENDING_REVIEW", uploadedAt: { not: null } },
      orderBy: { createdAt: "asc" },
      take: limit,
    });
    return rows.map(toRecord);
  }
}
