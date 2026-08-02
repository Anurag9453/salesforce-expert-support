import { apiFail, handleRoute } from "@/lib/route-helpers";
import { getContainer } from "@/lib/container";
import { requireActor } from "@/lib/session";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Serves an attachment (§30 — private storage, authorization-controlled).
 *
 * Three independent gates, in order: a valid signature, an authenticated
 * session, and ownership of the attachment. A signed URL that leaks is useless
 * to anyone else, and a customer cannot read another customer's attachment even
 * with a valid id.
 */
export async function GET(request: Request) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const url = new URL(request.url);
    const key = url.searchParams.get("key");
    const expires = Number(url.searchParams.get("expires"));
    const signature = url.searchParams.get("signature");

    if (!key || !signature || !Number.isFinite(expires)) {
      return apiFail("VALIDATION_ERROR", "Malformed download URL.");
    }

    const { storage, prisma } = getContainer();
    if (!storage.verify(key, expires, signature)) {
      return apiFail("FORBIDDEN", "This link is invalid or has expired.");
    }

    // Ownership is re-derived from the database, never from the URL. An
    // attachment belongs to whoever uploaded it, or to the customer whose
    // request it is bound to.
    const attachment = await prisma.attachment.findUnique({
      where: { storageKey: key },
      select: {
        id: true,
        filename: true,
        contentType: true,
        uploadedByUserId: true,
        request: { select: { customer: { select: { userId: true } } } },
      },
    });
    if (!attachment) return apiFail("NOT_FOUND", "Attachment not found.");

    const ownerUserIds = [attachment.uploadedByUserId, attachment.request?.customer.userId];
    if (!ownerUserIds.includes(actor.userId)) {
      return apiFail("FORBIDDEN", "You do not have access to this attachment.");
    }

    const body = await storage.get(key);

    return new NextResponse(new Uint8Array(body), {
      headers: {
        "content-type": attachment.contentType,
        // Never inline: an inline SVG or HTML attachment would execute in our
        // origin. Forcing a download removes that entirely.
        "content-disposition": `attachment; filename="${encodeURIComponent(attachment.filename)}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });
}
