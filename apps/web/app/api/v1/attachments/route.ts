import {
  ALLOWED_ATTACHMENT_TYPES,
  MAX_ATTACHMENT_BYTES,
  presignUploadSchema,
} from "@sfx/contracts";
import { RATE_LIMITS } from "@sfx/domain";
import { buildAttachmentKey } from "@sfx/adapters";
import { apiFail, apiOk, handleRoute, parseBody } from "@/lib/route-helpers";
import { getContainer } from "@/lib/container";
import { enforceRateLimit } from "@/lib/rate-limit";
import { requireActor } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Presign an upload (§7, §30).
 *
 * The attachment row is created here, unbound, and bound to a request when the
 * request is submitted. That is what lets someone attach a screenshot before
 * they have finished writing — and it is why binding is scoped to the uploader,
 * so an id from elsewhere cannot be attached to another customer's request.
 *
 * The storage key is generated server-side and never contains the customer's
 * filename, which removes filename-driven path traversal rather than sanitising
 * it. The filename is kept as metadata only.
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const actor = await requireActor();

    const limited = await enforceRateLimit(`user:${actor.userId}`, RATE_LIMITS.ATTACHMENT_UPLOAD);
    if (limited) return limited;

    const body = await parseBody(request, presignUploadSchema);
    if (!body.ok) return body.response;

    const { filename, contentType, sizeBytes } = body.data;

    // The extension must agree with the declared MIME type. A `.txt` claiming
    // to be a PNG is either confused tooling or someone probing.
    const allowedExtensions =
      ALLOWED_ATTACHMENT_TYPES[contentType as keyof typeof ALLOWED_ATTACHMENT_TYPES];
    if (!allowedExtensions) {
      return apiFail("VALIDATION_ERROR", "That file type is not supported.");
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
    if (sizeBytes > MAX_ATTACHMENT_BYTES) {
      return apiFail("VALIDATION_ERROR", "That file is larger than 10 MB.");
    }

    const { storage, attachments } = getContainer();
    const storageKey = buildAttachmentKey(actor.userId, filename);

    const presigned = await storage.presignUpload({
      key: storageKey,
      contentType,
      maxSizeBytes: MAX_ATTACHMENT_BYTES,
      ttlSeconds: 900,
    });

    const record = await attachments.create({
      supportRequestId: null,
      uploadedByUserId: actor.userId,
      storageKey,
      filename,
      contentType,
      sizeBytes,
    });

    return apiOk(
      {
        attachmentId: record.id,
        uploadUrl: presigned.url,
        fields: presigned.fields,
        expiresAt: presigned.expiresAt.toISOString(),
      },
      201,
    );
  });
}
