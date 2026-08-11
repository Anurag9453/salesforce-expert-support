import { getContainer } from "@/lib/container";
import { apiOk, handleRoute } from "@/lib/route-helpers";
import { photoUrlFor } from "@/lib/photo-view";
import { requireActor } from "@/lib/session";

export const dynamic = "force-dynamic";

/** The moderation queue: uploaded photos awaiting a human, oldest first. */
export async function GET() {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { expertPhotos, storage } = getContainer();

    const pending = await expertPhotos.listPendingReview(actor);
    const items = await Promise.all(
      pending.map(async (photo) => ({
        id: photo.id,
        expertProfileId: photo.expertProfileId,
        contentType: photo.contentType,
        sizeBytes: photo.sizeBytes,
        url: await photoUrlFor(storage, photo.storageKey),
        uploadedAt: photo.uploadedAt?.toISOString() ?? null,
      })),
    );
    return apiOk({ items });
  });
}
