"use client";

import { ALLOWED_PHOTO_TYPES, MAX_PHOTO_BYTES, type OwnPhotoView } from "@sfx/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Badge, Button } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * The expert's profile photo, and its moderation state.
 *
 * Three things this screen has to get right:
 *
 *   - **Say where the photo is.** A photo that has been uploaded but not yet
 *     approved is invisible to customers, and an expert who is not told that
 *     will assume it is live. So the state is always on screen, in words.
 *   - **Say why, on rejection.** The reviewer's note is shown verbatim. A
 *     rejection with no reason just produces the same upload again.
 *   - **Warn before uploading, not after.** The screening notice appears next to
 *     the button, because telling someone their photo will be reviewed *after*
 *     they have uploaded it is a worse experience than saying so up front.
 */

const STATUS: Record<
  OwnPhotoView["status"],
  { tone: "neutral" | "accent" | "available" | "warning" | "danger"; label: string; help: string }
> = {
  PENDING_REVIEW: {
    tone: "warning",
    label: "Waiting for review",
    help: "Customers cannot see this yet. Someone from our team checks every photo — usually within a day.",
  },
  APPROVED: {
    tone: "available",
    label: "Live",
    help: "This is the photo customers see when you appear as a candidate.",
  },
  REJECTED: {
    tone: "danger",
    label: "Not approved",
    help: "Customers cannot see this. Upload a different photo to try again.",
  },
  REPLACED: {
    tone: "neutral",
    label: "Replaced",
    help: "You have uploaded a newer photo since this one.",
  },
};

export function PhotoManager({ initial }: { initial: OwnPhotoView | null }) {
  const [photo, setPhoto] = useState<OwnPhotoView | null>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/expert/photo");
      const body = await response.json();
      if (body.ok) setPhoto(body.data.photo as OwnPhotoView | null);
    } catch {
      // The page still renders what it has; the next action will retry.
    }
  }, []);

  // Signed photo URLs are short-lived by design, so a page left open would end
  // up showing a broken image. Re-fetching well inside the TTL avoids that.
  useEffect(() => {
    const timer = setInterval(() => void refresh(), 4 * 60 * 1000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      // Client-side checks are a courtesy that saves a round-trip. The server
      // repeats both, and additionally checks the bytes themselves.
      if (!(file.type in ALLOWED_PHOTO_TYPES)) {
        setError("Use a PNG, JPEG or WebP image.");
        return;
      }
      if (file.size > MAX_PHOTO_BYTES) {
        setError("Images must be under 5 MB.");
        return;
      }

      const presign = await fetch("/api/v1/expert/photo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: file.name, contentType: file.type, sizeBytes: file.size }),
      });
      const presigned = await presign.json();
      if (!presigned.ok) {
        setError(presigned.error.message);
        return;
      }

      const put = await fetch(presigned.data.uploadUrl, { method: "PUT", body: file });
      const result = await put.json();
      if (!result.ok) {
        setError(result.error?.message ?? "That image could not be uploaded.");
        // The slot was reserved and the bytes failed, so the previous photo is
        // already superseded — refresh so the screen tells the truth.
        await refresh();
        return;
      }

      await refresh();
    } catch {
      setError("Could not reach the server. Check your connection.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await fetch("/api/v1/expert/photo", { method: "DELETE" });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const state = photo ? STATUS[photo.status] : null;
  const showable = photo?.url && photo.status !== "REPLACED";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-5">
        <div
          className={cn(
            "relative size-24 shrink-0 overflow-hidden rounded-xl border bg-surface-sunken",
            photo?.status === "APPROVED" ? "border-available/40" : "border-border",
          )}
        >
          {/* A plain <img> rather than next/image: the URL is signed and
              short-lived, so the optimizer can neither fetch nor cache it. */}
          {showable ? (
            <img
              src={photo.url ?? ""}
              alt="Your profile photo"
              className={cn("size-full object-cover", photo.status !== "APPROVED" && "opacity-60")}
            />
          ) : (
            <Placeholder />
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          {state && (
            <Badge tone={state.tone} dot>
              {state.label}
            </Badge>
          )}
          <p className="text-sm leading-relaxed text-ink-muted">
            {state?.help ??
              "A photo makes a real difference when customers are choosing between candidates."}
          </p>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <input
              ref={fileRef}
              type="file"
              accept={Object.keys(ALLOWED_PHOTO_TYPES).join(",")}
              className="sr-only"
              id="photo-input"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void upload(file);
              }}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              {busy ? "Uploading…" : photo ? "Replace photo" : "Upload a photo"}
            </Button>
            {photo && photo.status !== "REPLACED" && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void remove()}>
                Remove
              </Button>
            )}
          </div>
        </div>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      {photo?.status === "REJECTED" && photo.reviewNote && (
        <Alert tone="danger" title="Why it was not approved">
          {photo.reviewNote}
        </Alert>
      )}

      {/*
        Said before they upload, not after. Requirement: inform them that photos
        are screened.
      */}
      <p className="text-xs leading-relaxed text-ink-subtle">
        Every photo is reviewed by a person before customers see it. Use a clear, recent picture of
        your face — no logos, no group shots, and nothing you would not want a client to see. PNG,
        JPEG or WebP, up to 5 MB.
      </p>
    </div>
  );
}

/** Shown when there is no approved photo. Deliberately a silhouette, not initials. */
function Placeholder() {
  return (
    <div className="grid size-full place-items-center text-ink-subtle" aria-hidden="true">
      <svg
        width="40"
        height="40"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" strokeLinecap="round" />
      </svg>
    </div>
  );
}
