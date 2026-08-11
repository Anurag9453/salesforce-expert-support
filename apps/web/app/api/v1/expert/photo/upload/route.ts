import { ALLOWED_PHOTO_TYPES, MAX_PHOTO_BYTES } from "@sfx/contracts";
import { validatePhotoBytes } from "@sfx/domain";
import { NextResponse } from "next/server";
import { apiFail, handleRoute } from "@/lib/route-helpers";
import { getContainer } from "@/lib/container";
import { requireActor } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Receives the bytes for a presigned photo upload.
 *
 * Four gates, in order, and each one is independent:
 *
 *   1. an authenticated session
 *   2. a valid HMAC on the presigned URL
 *   3. the key belongs to a photo row owned by this expert  ← the service checks
 *   4. **the bytes are actually the image they claim to be**
 *
 * Gate 4 is the one that does not exist for attachments, and it is here because
 * the trust model is different: an attachment is served
 * `content-disposition: attachment` precisely so a disguised HTML or SVG file
 * cannot execute, whereas a profile photo is rendered inline in an `<img>`. So
 * "is this genuinely a raster image" has to be established from the bytes, not
 * from a content-type the uploader chose.
 */
export async function PUT(request: Request) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const url = new URL(request.url);
    const key = url.searchParams.get("key");
    const expires = Number(url.searchParams.get("expires"));
    const signature = url.searchParams.get("signature");

    if (!key || !signature || !Number.isFinite(expires)) {
      return apiFail("VALIDATION_ERROR", "Malformed upload URL.");
    }

    const { storage, expertPhotos } = getContainer();
    if (!storage.verify(key, expires, signature)) {
      return apiFail("FORBIDDEN", "This upload link is invalid or has expired.");
    }

    const bytes = new Uint8Array(await request.arrayBuffer());

    // The row is the source of truth for what this key was reserved as — not the
    // request's own content-type header, which the client also controls. This
    // also enforces that the key belongs to the caller.
    const reserved = await expertPhotos.reservedForUpload(actor, key);

    const verdict = validatePhotoBytes({
      bytes,
      declaredContentType: reserved.contentType,
      maxBytes: MAX_PHOTO_BYTES,
      allowedTypes: Object.keys(ALLOWED_PHOTO_TYPES),
    });
    if (!verdict.ok) {
      return apiFail("VALIDATION_ERROR", verdict.message ?? "That image could not be accepted.");
    }

    await storage.put(key, Buffer.from(bytes));
    // Ownership is enforced inside the service, which re-derives it from the row.
    await expertPhotos.markUploaded(actor, key, bytes.byteLength);

    return NextResponse.json({
      ok: true as const,
      data: { bytes: bytes.byteLength, status: "PENDING_REVIEW" },
    });
  });
}
