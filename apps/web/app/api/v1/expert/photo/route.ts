import {
  ALLOWED_PHOTO_TYPES,
  MAX_PHOTO_BYTES,
  presignPhotoSchema,
  type OwnPhotoView,
} from "@sfx/contracts";
import { RATE_LIMITS } from "@sfx/domain";
import { buildExpertPhotoKey } from "@sfx/adapters";
import { apiFail, apiOk, handleRoute, parseBody } from "@/lib/route-helpers";
import { getContainer } from "@/lib/container";
import { enforceRateLimit } from "@/lib/rate-limit";
import { requireActor } from "@/lib/session";
import { photoUrlFor } from "@/lib/photo-view";

export const dynamic = "force-dynamic";

/** The expert's own photo — pending and rejected included, so they know why. */
export async function GET() {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { expertPhotos, storage } = getContainer();

    const photo = await expertPhotos.ownPhoto(actor);
    if (!photo) return apiOk({ photo: null });

    const view: OwnPhotoView = {
      id: photo.id,
      status: photo.status,
      url: photo.uploadedAt ? await photoUrlFor(storage, photo.storageKey) : null,
      reviewNote: photo.reviewNote,
      uploadedAt: photo.uploadedAt?.toISOString() ?? null,
      reviewedAt: photo.reviewedAt?.toISOString() ?? null,
    };
    return apiOk({ photo: view });
  });
}

/**
 * Reserve an upload slot.
 *
 * Mirrors the attachment presign flow: the row is created here so the storage
 * key has an owner before any bytes arrive, which is what lets the upload
 * endpoint check the key belongs to the caller rather than trusting a signature
 * alone.
 *
 * The key is generated server-side from the declared content type and never
 * contains the uploader's filename — removing filename-driven path traversal
 * rather than sanitising it.
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const actor = await requireActor();

    const limited = await enforceRateLimit(`user:${actor.userId}`, RATE_LIMITS.ATTACHMENT_UPLOAD);
    if (limited) return limited;

    const body = await parseBody(request, presignPhotoSchema);
    if (!body.ok) return body.response;

    const { filename, contentType, sizeBytes } = body.data;

    const allowedExtensions = ALLOWED_PHOTO_TYPES[contentType as keyof typeof ALLOWED_PHOTO_TYPES];
    if (!allowedExtensions) {
      return apiFail("VALIDATION_ERROR", "Use a PNG, JPEG or WebP image.");
    }
    const extension = filename.includes(".") ? `.${filename.split(".").pop()?.toLowerCase()}` : "";
    if (!(allowedExtensions as readonly string[]).includes(extension)) {
      return apiFail(
        "VALIDATION_ERROR",
        `A ${contentType} file should end in ${allowedExtensions.join(" or ")}.`,
        {
          filename: ["The file extension does not match its type."],
        },
      );
    }

    const { storage, expertPhotos } = getContainer();
    const expertProfileId = actor.expert?.profileId;
    if (!expertProfileId) return apiFail("FORBIDDEN", "You do not have an expert profile.");

    const storageKey = buildExpertPhotoKey(expertProfileId, contentType);
    const presigned = await storage.presignUpload({
      key: storageKey,
      contentType,
      maxSizeBytes: MAX_PHOTO_BYTES,
      ttlSeconds: 900,
      // Photos have their own receiver: it verifies the bytes really are a
      // raster image, which the attachment receiver has no reason to do.
      uploadPath: "/api/v1/expert/photo/upload",
    });

    // Supersedes any previous photo — see ExpertPhotoService.reserve.
    const record = await expertPhotos.reserve(actor, { storageKey, contentType, sizeBytes });

    return apiOk(
      {
        photoId: record.id,
        uploadUrl: presigned.url,
        fields: presigned.fields,
        expiresAt: presigned.expiresAt.toISOString(),
      },
      201,
    );
  });
}

/** Removes the current photo. Supersedes rather than deletes, for the audit trail. */
export async function DELETE() {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { expertPhotos } = getContainer();
    return apiOk(await expertPhotos.removeOwn(actor));
  });
}
