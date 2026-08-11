import { describe, expect, it, beforeEach } from "vitest";
import type { Actor } from "../authorization/index.js";
import type { ExpertPhotoRecord, ExpertPhotoRepository } from "../ports/expert-photo-repository.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import { ExpertPhotoService } from "./expert-photo-service.js";

/**
 * A fake that models the *query semantics* of the Prisma repository, not just
 * its signatures — `findApprovedForExpert` really does refuse to return an
 * unapproved row, and supersede really does rewrite the others.
 *
 * A fake that only stored and returned rows would let the visibility rule pass
 * every test here while production leaked pending photos. That adapter/fake
 * divergence has bitten this project before.
 */
class FakePhotoRepository implements ExpertPhotoRepository {
  readonly rows: ExpertPhotoRecord[] = [];
  private seq = 0;

  async create(input: {
    expertProfileId: string;
    storageKey: string;
    contentType: string;
    sizeBytes: number;
  }): Promise<ExpertPhotoRecord> {
    this.seq += 1;
    const record: ExpertPhotoRecord = {
      id: `photo_${String(this.seq)}`,
      expertProfileId: input.expertProfileId,
      storageKey: input.storageKey,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      status: "PENDING_REVIEW",
      reviewNote: null,
      uploadedAt: null,
      reviewedAt: null,
      createdAt: new Date(2026, 0, this.seq),
    };
    this.rows.push(record);
    return record;
  }

  async findById(id: string) {
    return this.rows.find((row) => row.id === id) ?? null;
  }
  async findByStorageKey(storageKey: string) {
    return this.rows.find((row) => row.storageKey === storageKey) ?? null;
  }
  async findCurrentForExpert(expertProfileId: string) {
    return (
      [...this.rows]
        .reverse()
        .find((row) => row.expertProfileId === expertProfileId && row.status !== "REPLACED") ?? null
    );
  }
  async findApprovedForExpert(expertProfileId: string) {
    return (
      [...this.rows]
        .reverse()
        .find((row) => row.expertProfileId === expertProfileId && row.status === "APPROVED") ?? null
    );
  }
  async findApprovedForExperts(ids: readonly string[]) {
    const map = new Map<string, ExpertPhotoRecord>();
    for (const row of [...this.rows].reverse()) {
      if (
        ids.includes(row.expertProfileId) &&
        row.status === "APPROVED" &&
        !map.has(row.expertProfileId)
      ) {
        map.set(row.expertProfileId, row);
      }
    }
    return map;
  }
  async markUploaded(params: { id: string; sizeBytes: number; uploadedAt: Date }) {
    this.replace(params.id, { sizeBytes: params.sizeBytes, uploadedAt: params.uploadedAt });
  }
  async decide(params: {
    id: string;
    status: "APPROVED" | "REJECTED";
    reviewedByUserId: string;
    reviewedAt: Date;
    reviewNote: string | null;
  }) {
    this.replace(params.id, {
      status: params.status,
      reviewedAt: params.reviewedAt,
      reviewNote: params.reviewNote,
    });
    return (await this.findById(params.id)) as ExpertPhotoRecord;
  }
  async supersedeAllForExpert(params: { expertProfileId: string; exceptId?: string }) {
    let count = 0;
    for (const row of this.rows) {
      if (
        row.expertProfileId === params.expertProfileId &&
        row.status !== "REPLACED" &&
        row.id !== params.exceptId
      ) {
        this.replace(row.id, { status: "REPLACED" });
        count += 1;
      }
    }
    return count;
  }
  async listPendingReview(limit: number) {
    return this.rows
      .filter((row) => row.status === "PENDING_REVIEW" && row.uploadedAt !== null)
      .slice(0, limit);
  }

  private replace(id: string, patch: Partial<ExpertPhotoRecord>) {
    const index = this.rows.findIndex((row) => row.id === id);
    if (index >= 0) this.rows[index] = { ...(this.rows[index] as ExpertPhotoRecord), ...patch };
  }
}

const NOW = new Date("2026-03-01T10:00:00.000Z");
const clock = { now: () => NOW };

function expert(profileId = "exp_1"): Actor {
  return {
    userId: `user_${profileId}`,
    email: "e@x.test",
    name: "E",
    roles: ["CUSTOMER", "EXPERT"],
    status: "ACTIVE",
    expert: { profileId, status: "APPROVED" },
    customerProfileId: `cust_${profileId}`,
  } as unknown as Actor;
}

function admin(): Actor {
  return {
    userId: "user_admin",
    email: "a@x.test",
    name: "A",
    roles: ["CUSTOMER", "ADMIN"],
    status: "ACTIVE",
    customerProfileId: "cust_admin",
  } as unknown as Actor;
}

function customer(): Actor {
  return {
    userId: "user_cust",
    email: "c@x.test",
    name: "C",
    roles: ["CUSTOMER"],
    status: "ACTIVE",
    customerProfileId: "cust_only",
  } as unknown as Actor;
}

let photos: FakePhotoRepository;
let service: ExpertPhotoService;

beforeEach(() => {
  photos = new FakePhotoRepository();
  service = new ExpertPhotoService({ photos, clock });
});

/** Reserve → upload → (optionally) approve. */
async function uploadFor(actor: Actor, key = "expert-photos/exp_1/a.png") {
  const record = await service.reserve(actor, {
    storageKey: key,
    contentType: "image/png",
    sizeBytes: 1000,
  });
  await service.markUploaded(actor, key, 2048);
  return record;
}

describe("uploading", () => {
  it("creates a pending photo and records the real byte count", async () => {
    const record = await uploadFor(expert());
    const stored = await photos.findById(record.id);
    expect(stored?.status).toBe("PENDING_REVIEW");
    // 2048 from the upload, not the 1000 declared at presign — the declared
    // size was only ever a pre-flight hint the client chose.
    expect(stored?.sizeBytes).toBe(2048);
    expect(stored?.uploadedAt).toEqual(NOW);
  });

  it("refuses an account with no expert profile", async () => {
    await expect(
      service.reserve(customer(), {
        storageKey: "k",
        contentType: "image/png",
        sizeBytes: 10,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses to attach bytes to another expert's reserved key", async () => {
    // Ownership is re-derived from the row, never from the key's shape.
    await service.reserve(expert("exp_1"), {
      storageKey: "expert-photos/exp_1/a.png",
      contentType: "image/png",
      sizeBytes: 10,
    });
    await expect(
      service.markUploaded(expert("exp_2"), "expert-photos/exp_1/a.png", 100),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("refuses an unknown storage key", async () => {
    await expect(service.markUploaded(expert(), "nope", 1)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("customer visibility — the rule that matters", () => {
  it("shows nothing while the photo is pending review", async () => {
    await uploadFor(expert());
    expect(await service.currentApproved("exp_1")).toBeNull();
  });

  it("shows the photo once approved", async () => {
    const record = await uploadFor(expert());
    await service.decide(admin(), record.id, { approve: true });
    expect((await service.currentApproved("exp_1"))?.id).toBe(record.id);
  });

  it("shows nothing when the photo was rejected", async () => {
    const record = await uploadFor(expert());
    await service.decide(admin(), record.id, { approve: false, note: "Not a headshot." });
    expect(await service.currentApproved("exp_1")).toBeNull();
  });

  it("hides a replaced photo even though it was once approved", async () => {
    const first = await uploadFor(expert(), "expert-photos/exp_1/one.png");
    await service.decide(admin(), first.id, { approve: true });
    expect(await service.currentApproved("exp_1")).not.toBeNull();

    // Replacing supersedes the approved one; the new one is pending, so the
    // customer-facing answer is nothing at all.
    await uploadFor(expert(), "expert-photos/exp_1/two.png");
    expect(await service.currentApproved("exp_1")).toBeNull();
  });

  it("applies the same rule in bulk for shortlist cards", async () => {
    const a = await uploadFor(expert("exp_1"), "expert-photos/exp_1/a.png");
    await service.decide(admin(), a.id, { approve: true });
    await uploadFor(expert("exp_2"), "expert-photos/exp_2/b.png"); // left pending

    const map = await service.approvedForMany(["exp_1", "exp_2"]);
    expect(map.get("exp_1")?.id).toBe(a.id);
    expect(map.has("exp_2")).toBe(false);
  });

  it("returns an empty map for no experts rather than querying", async () => {
    expect((await service.approvedForMany([])).size).toBe(0);
  });
});

describe("the expert's own view", () => {
  it("shows their pending photo, so they know it is waiting", async () => {
    await uploadFor(expert());
    expect((await service.ownPhoto(expert()))?.status).toBe("PENDING_REVIEW");
  });

  it("shows the rejection reason", async () => {
    const record = await uploadFor(expert());
    await service.decide(admin(), record.id, { approve: false, note: "Please use a clear photo." });
    const own = await service.ownPhoto(expert());
    expect(own?.status).toBe("REJECTED");
    expect(own?.reviewNote).toBe("Please use a clear photo.");
  });
});

describe("replacement keeps history", () => {
  it("supersedes rather than deletes", async () => {
    await uploadFor(expert(), "expert-photos/exp_1/one.png");
    await uploadFor(expert(), "expert-photos/exp_1/two.png");

    // Both rows survive; the audit trail of what customers saw is intact.
    expect(photos.rows).toHaveLength(2);
    expect(photos.rows[0]?.status).toBe("REPLACED");
    expect(photos.rows[1]?.status).toBe("PENDING_REVIEW");
  });

  it("removal supersedes too, leaving nothing visible", async () => {
    const record = await uploadFor(expert());
    await service.decide(admin(), record.id, { approve: true });

    const { removed } = await service.removeOwn(expert());
    expect(removed).toBe(1);
    expect(await service.currentApproved("exp_1")).toBeNull();
    expect(photos.rows[0]?.status).toBe("REPLACED");
  });
});

describe("moderation", () => {
  it("requires a reason to reject", async () => {
    const record = await uploadFor(expert());
    await expect(
      service.decide(admin(), record.id, { approve: false, note: "   " }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses a non-admin", async () => {
    const record = await uploadFor(expert());
    // Not even the expert may approve their own photo.
    await expect(service.decide(expert(), record.id, { approve: true })).rejects.toThrow();
    await expect(service.decide(customer(), record.id, { approve: true })).rejects.toThrow();
  });

  it("refuses to re-decide an already-reviewed photo", async () => {
    // Re-deciding would silently rewrite what customers have already been shown.
    const record = await uploadFor(expert());
    await service.decide(admin(), record.id, { approve: true });
    await expect(
      service.decide(admin(), record.id, { approve: false, note: "x" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses to approve a photo whose bytes never arrived", async () => {
    const reserved = await service.reserve(expert(), {
      storageKey: "expert-photos/exp_1/ghost.png",
      contentType: "image/png",
      sizeBytes: 10,
    });
    await expect(service.decide(admin(), reserved.id, { approve: true })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("only queues photos that were actually uploaded", async () => {
    await service.reserve(expert("exp_1"), {
      storageKey: "expert-photos/exp_1/ghost.png",
      contentType: "image/png",
      sizeBytes: 10,
    });
    await uploadFor(expert("exp_2"), "expert-photos/exp_2/real.png");

    const queue = await service.listPendingReview(admin());
    expect(queue).toHaveLength(1);
    expect(queue[0]?.expertProfileId).toBe("exp_2");
  });

  it("refuses a non-admin the review queue", async () => {
    await expect(service.listPendingReview(expert())).rejects.toThrow();
  });

  it("refuses an unknown photo id", async () => {
    await expect(service.decide(admin(), "nope", { approve: true })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
