import { NextResponse } from "next/server";
import { ALLOWED_PHOTO_TYPES } from "@sfx/contracts";
import { apiFail, handleRoute } from "@/lib/route-helpers";
import { getContainer } from "@/lib/container";
import { requireActor } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Serves an expert photo.
 *
 * Four gates, and the fourth is the one this whole feature exists for:
 *
 *   1. an authenticated session
 *   2. a valid signature on the URL
 *   3. the object is a known photo row
 *   4. **it is APPROVED — unless the viewer is the expert themselves**
 *
 * Gate 4 is why the rule cannot be a UI concern. A signed URL for a pending
 * photo could otherwise be lifted from an admin's screen and replayed by anyone
 * with an account, and the moderation state would have decided nothing.
 *
 * The expert and an admin reviewer are the two exceptions: an expert must see
 * their own pending or rejected photo to know what happened, and a reviewer must
 * see it in order to review it.
 *
 * Unlike attachments — which are forced to download precisely so a disguised
 * file cannot execute — this is served **inline**, because it renders in an
 * `<img>`. That is safe only because the bytes were verified against their
 * magic number at upload, the content type is re-derived from the row rather
 * than echoed from the request, and `nosniff` stops the browser second-guessing
 * either.
 */
export async function GET(request: Request) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const url = new URL(request.url);
    const key = url.searchParams.get("key");
    const expires = Number(url.searchParams.get("expires"));
    const signature = url.searchParams.get("signature");

    if (!key || !signature || !Number.isFinite(expires)) {
      return apiFail("VALIDATION_ERROR", "Malformed photo URL.");
    }

    const { storage, expertPhotos, logger } = getContainer();
    if (!storage.verify(key, expires, signature)) {
      return apiFail("FORBIDDEN", "This link is invalid or has expired.");
    }

    const photo = await expertPhotos.findByStorageKeyForServing(key);
    if (!photo) return apiFail("NOT_FOUND", "Photo not found.");

    const isOwner = actor.expert?.profileId === photo.expertProfileId;
    const isReviewer = actor.roles.includes("ADMIN");
    if (photo.status !== "APPROVED" && !isOwner && !isReviewer) {
      // Deliberately NOT_FOUND rather than FORBIDDEN: a distinct "you may not
      // see this" would confirm that an unapproved photo exists, which is
      // exactly what an expert should not have leaked about them.
      logger.warn("blocked an unapproved photo request", {
        status: photo.status,
        viewer: actor.userId,
      });
      return apiFail("NOT_FOUND", "Photo not found.");
    }

    // Re-derived from the row, never echoed from the request, and constrained to
    // the types we accept — so this header cannot be steered by a caller.
    const contentType =
      photo.contentType in ALLOWED_PHOTO_TYPES ? photo.contentType : "application/octet-stream";

    const body = await storage.get(key);
    return new NextResponse(new Uint8Array(body), {
      headers: {
        "content-type": contentType,
        "content-disposition": "inline",
        // The browser must not sniff its way to a different interpretation.
        "x-content-type-options": "nosniff",
        // Signed URLs are short-lived; private caching only, never shared.
        "cache-control": "private, max-age=60",
      },
    });
  });
}
