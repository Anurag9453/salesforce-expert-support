import type { LocalFileStorage } from "@sfx/adapters";

/**
 * A short-TTL signed URL for a photo object.
 *
 * Photos are never publicly readable — the same rule as attachments — so every
 * render goes through a signed URL that expires. Five minutes is enough for a
 * page to load and short enough that a URL copied out of devtools is useless
 * shortly after.
 *
 * This helper exists so no caller hand-rolls the TTL and accidentally issues a
 * long-lived link to an image of somebody's face.
 */
export const PHOTO_URL_TTL_SECONDS = 300;

export function photoUrlFor(storage: LocalFileStorage, storageKey: string): Promise<string> {
  return storage.presignDownload(storageKey, PHOTO_URL_TTL_SECONDS, "/api/v1/photos");
}
