import type { PhotoModerationStatus } from "@sfx/contracts";
import { authorize, type Actor } from "../authorization/index.js";
import type { Clock } from "../ports/clock.js";
import type { ExpertPhotoRecord, ExpertPhotoRepository } from "../ports/expert-photo-repository.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";

/**
 * Expert profile photos and their moderation.
 *
 * ## The rule that matters
 *
 * **A customer never sees a photo that has not been approved by a human.** That
 * is enforced here and in the repository — `currentApproved` is the only method
 * any customer-facing caller may use, and it cannot return a PENDING_REVIEW or
 * REJECTED row. Filtering in the UI would make the guarantee a habit rather than
 * a property.
 *
 * ## Why there is no automated moderation provider
 *
 * There isn't one, and inventing an integration with a service nobody has chosen
 * would be worse than the honest gap. So the model is built — states, reviewer,
 * reason, history — and the decision is made by an admin. If an automated
 * classifier arrives later it becomes another actor calling `decide`, and
 * nothing else changes.
 *
 * ## Replacement keeps history
 *
 * Uploading a new photo supersedes the previous one rather than deleting it. An
 * expert who swaps their photo leaves a trail of what customers were shown and
 * when — which is the whole point of moderating in the first place.
 */
export class ExpertPhotoService {
  constructor(
    private readonly deps: {
      readonly photos: ExpertPhotoRepository;
      readonly clock: Clock;
    },
  ) {}

  /**
   * Reserves a row for an upload that has not happened yet.
   *
   * The row exists from presign time so the storage key has an owner before any
   * bytes arrive — that is what lets the upload endpoint verify the key belongs
   * to the caller instead of trusting a signature alone.
   *
   * Supersedes anything previous immediately rather than on success. An expert
   * who starts replacing their photo and abandons it should not be left showing
   * the old one while a half-finished row sits pending; and the old row is kept,
   * so nothing is lost.
   */
  async reserve(
    actor: Actor,
    input: { storageKey: string; contentType: string; sizeBytes: number },
  ): Promise<ExpertPhotoRecord> {
    authorize(actor, "expert_profile:update_own");
    const expertProfileId = this.requireExpertProfile(actor);

    await this.deps.photos.supersedeAllForExpert({ expertProfileId });
    return this.deps.photos.create({
      expertProfileId,
      storageKey: input.storageKey,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
    });
  }

  /**
   * The row a storage key was reserved as, if it belongs to the caller.
   *
   * The upload route needs the *declared* content type before it can check the
   * bytes against it — and that must come from the row we wrote at presign time,
   * never from a header on the upload request, which the client also controls.
   *
   * Doubles as the ownership gate: a key that is not the caller's is Forbidden.
   */
  async reservedForUpload(actor: Actor, storageKey: string): Promise<ExpertPhotoRecord> {
    authorize(actor, "expert_profile:update_own");
    const expertProfileId = this.requireExpertProfile(actor);

    const photo = await this.deps.photos.findByStorageKey(storageKey);
    if (!photo) throw new NotFoundError("ExpertPhoto", storageKey);
    if (photo.expertProfileId !== expertProfileId) {
      throw new ForbiddenError("expert_photo:upload", `expert:${expertProfileId}`);
    }
    return photo;
  }

  /**
   * Records that the bytes arrived and passed validation.
   *
   * The size is the real byte count, not the one declared at presign — that was
   * only ever a pre-flight hint and the client chose it.
   */
  async markUploaded(actor: Actor, storageKey: string, sizeBytes: number): Promise<void> {
    authorize(actor, "expert_profile:update_own");
    const expertProfileId = this.requireExpertProfile(actor);

    const photo = await this.deps.photos.findByStorageKey(storageKey);
    if (!photo) throw new NotFoundError("ExpertPhoto", storageKey);
    // Ownership is re-derived from the row, never from the key's shape.
    if (photo.expertProfileId !== expertProfileId) {
      throw new ForbiddenError("expert_photo:upload", `expert:${expertProfileId}`);
    }

    await this.deps.photos.markUploaded({
      id: photo.id,
      sizeBytes,
      uploadedAt: this.deps.clock.now(),
    });
  }

  /**
   * The row behind a storage key, for the serving endpoint to authorize against.
   *
   * Returns the record without deciding anything — the route compares the status
   * against the viewer, because "may this person see this photo" depends on who
   * is asking and the service has no session. Deliberately not named `find…Own`:
   * it is reached by admins and customers too.
   */
  async findByStorageKeyForServing(storageKey: string): Promise<ExpertPhotoRecord | null> {
    return this.deps.photos.findByStorageKey(storageKey);
  }

  /** The expert's own photo — including pending and rejected, so they know why. */
  async ownPhoto(actor: Actor): Promise<ExpertPhotoRecord | null> {
    authorize(actor, "expert_profile:read_own");
    const expertProfileId = this.requireExpertProfile(actor);
    return this.deps.photos.findCurrentForExpert(expertProfileId);
  }

  /**
   * The approved photo for an expert, or null.
   *
   * **This is the only method a customer-facing surface may call.** It cannot
   * return an unapproved photo, so the visibility rule holds even if a caller
   * forgets it exists.
   */
  async currentApproved(expertProfileId: string): Promise<ExpertPhotoRecord | null> {
    return this.deps.photos.findApprovedForExpert(expertProfileId);
  }

  /** The same rule, in bulk — for the shortlist cards. */
  async approvedForMany(
    expertProfileIds: readonly string[],
  ): Promise<ReadonlyMap<string, ExpertPhotoRecord>> {
    if (expertProfileIds.length === 0) return new Map();
    return this.deps.photos.findApprovedForExperts(expertProfileIds);
  }

  /** Removes the expert's photo. Supersedes rather than deletes, for the trail. */
  async removeOwn(actor: Actor): Promise<{ removed: number }> {
    authorize(actor, "expert_profile:update_own");
    const expertProfileId = this.requireExpertProfile(actor);
    const removed = await this.deps.photos.supersedeAllForExpert({ expertProfileId });
    return { removed };
  }

  // ── Moderation ────────────────────────────────────────────────────────────

  async listPendingReview(actor: Actor, limit = 50): Promise<readonly ExpertPhotoRecord[]> {
    authorize(actor, "admin:review_expert");
    return this.deps.photos.listPendingReview(Math.min(Math.max(limit, 1), 100));
  }

  /**
   * Approve or reject, with a mandatory reason on rejection.
   *
   * An expert told only "rejected" cannot fix anything and will upload the same
   * photo again, so the reason is enforced here rather than left to the UI.
   *
   * Only a photo still awaiting review can be decided. Re-deciding an approved
   * photo would silently rewrite what customers have already been shown.
   */
  async decide(
    actor: Actor,
    photoId: string,
    decision: { approve: true } | { approve: false; note: string },
  ): Promise<ExpertPhotoRecord> {
    authorize(actor, "admin:review_expert");

    const photo = await this.deps.photos.findById(photoId);
    if (!photo) throw new NotFoundError("ExpertPhoto", photoId);

    if (photo.status !== "PENDING_REVIEW") {
      throw new ValidationError("That photo has already been reviewed.", {
        status: [photo.status],
      });
    }
    if (!photo.uploadedAt) {
      // Reserved but never uploaded. Approving it would publish nothing.
      throw new ValidationError("That photo was never uploaded.", { upload: ["missing"] });
    }
    if (!decision.approve && decision.note.trim() === "") {
      throw new ValidationError("Tell them what to change.", { note: ["required"] });
    }

    return this.deps.photos.decide({
      id: photo.id,
      status: decision.approve ? "APPROVED" : "REJECTED",
      reviewedByUserId: actor.userId,
      reviewedAt: this.deps.clock.now(),
      reviewNote: decision.approve ? null : decision.note.trim(),
    });
  }

  private requireExpertProfile(actor: Actor): string {
    const id = actor.expert?.profileId;
    if (!id) {
      throw new ForbiddenError("expert_profile:update_own", `user:${actor.userId}`);
    }
    return id;
  }
}

/** Statuses a customer may ever be shown. Exported so the rule is greppable. */
export const CUSTOMER_VISIBLE_PHOTO_STATUSES: readonly PhotoModerationStatus[] = ["APPROVED"];
