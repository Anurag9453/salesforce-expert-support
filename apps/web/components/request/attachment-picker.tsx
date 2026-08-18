"use client";

import { ALLOWED_ATTACHMENT_TYPES, MAX_ATTACHMENTS_PER_REQUEST } from "@sfx/contracts";
import { useRef, useState } from "react";
import { Button } from "@/components/ui";

/**
 * Screenshot and log upload.
 *
 * Uploads happen as soon as a file is chosen, so submitting the request is
 * instant rather than waiting on a 10 MB PDF (requirement 3). Each attachment
 * is created unbound and bound to the request on submit.
 *
 * Everything here is a convenience: the `accept` attribute, the size check, the
 * extension check. All three are re-checked server-side, because a client-side
 * file filter is a hint to the file picker and nothing more (§30).
 */
export interface PendingAttachment {
  readonly id: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly uploaded: boolean;
  readonly error?: string;
}

const ACCEPT = Object.entries(ALLOWED_ATTACHMENT_TYPES)
  .flatMap(([mime, extensions]) => [mime, ...extensions])
  .join(",");

export function AttachmentPicker({
  attachments,
  onChange,
}: {
  attachments: PendingAttachment[];
  onChange: (next: PendingAttachment[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    const presign = await fetch("/api/v1/attachments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: file.name,
        contentType: file.type || "text/plain",
        sizeBytes: file.size,
      }),
    });
    const presignBody = await presign.json();
    if (!presignBody.ok) throw new Error(presignBody.error.message);

    const put = await fetch(presignBody.data.uploadUrl, {
      method: "PUT",
      headers: { "content-type": file.type || "text/plain" },
      body: file,
    });
    if (!put.ok) throw new Error("Upload failed. Please try again.");

    return {
      id: presignBody.data.attachmentId as string,
      filename: file.name,
      sizeBytes: file.size,
      uploaded: true,
    };
  }

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);

    const room = MAX_ATTACHMENTS_PER_REQUEST - attachments.length;
    const chosen = [...files].slice(0, Math.max(0, room));
    const next = [...attachments];

    for (const file of chosen) {
      try {
        next.push(await upload(file));
      } catch (error) {
        next.push({
          id: `failed-${file.name}-${next.length}`,
          filename: file.name,
          sizeBytes: file.size,
          uploaded: false,
          error: error instanceof Error ? error.message : "Upload failed.",
        });
      }
    }

    onChange(next);
    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
  }

  const atLimit = attachments.length >= MAX_ATTACHMENTS_PER_REQUEST;

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-ink">Screenshots or logs?</p>
      <p className="text-xs text-ink-subtle">
        Optional. Images, logs, CSV, JSON, XML or PDF, up to 10 MB each. Only you and the expert
        matched to this request can open them.
      </p>

      {attachments.length > 0 && (
        <ul className="space-y-1.5 pt-1">
          {attachments.map((attachment, index) => (
            <li
              key={attachment.id}
              className="flex items-center gap-2 rounded-sm border border-border bg-surface-raised px-2.5 py-1.5 text-xs"
            >
              <span className="truncate text-ink">{attachment.filename}</span>
              <span className="text-ink-subtle">{formatBytes(attachment.sizeBytes)}</span>
              {attachment.error ? (
                <span className="text-danger">{attachment.error}</span>
              ) : (
                <span className="text-available">attached</span>
              )}
              <button
                type="button"
                onClick={() => onChange(attachments.filter((_, i) => i !== index))}
                className="ml-auto text-ink-subtle hover:text-ink"
                aria-label={`Remove ${attachment.filename}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        onChange={(event) => void onFiles(event.target.files)}
      />
      <Button
        type="button"
        variant="secondary"
        size="sm"
        loading={busy}
        disabled={busy || atLimit}
        onClick={() => inputRef.current?.click()}
      >
        {busy
          ? "Uploading…"
          : atLimit
            ? `Limit of ${MAX_ATTACHMENTS_PER_REQUEST} reached`
            : "Choose files"}
      </Button>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
