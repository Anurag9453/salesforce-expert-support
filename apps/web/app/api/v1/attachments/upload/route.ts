import { MAX_ATTACHMENT_BYTES } from "@sfx/contracts";
import { apiFail, handleRoute } from "@/lib/route-helpers";
import { getContainer } from "@/lib/container";
import { requireActor } from "@/lib/session";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Receives the bytes for a presigned local upload.
 *
 * Stands in for R2's direct-to-bucket PUT, so the client code is identical
 * either way. Two checks, both server-side: the HMAC signature must verify, and
 * the key must belong to the signed-in user. The signature alone is not enough —
 * a leaked URL should not be usable by someone else's session.
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

    const { storage } = getContainer();
    if (!storage.verify(key, expires, signature)) {
      return apiFail("FORBIDDEN", "This upload link is invalid or has expired.");
    }
    if (!key.startsWith(`attachments/${actor.userId}/`)) {
      return apiFail("FORBIDDEN", "This upload link does not belong to you.");
    }

    const body = Buffer.from(await request.arrayBuffer());
    // The declared size was validated at presign time; this is the actual size,
    // which is the one that matters.
    if (body.byteLength > MAX_ATTACHMENT_BYTES) {
      return apiFail("VALIDATION_ERROR", "That file is larger than 10 MB.");
    }

    await storage.put(key, body);

    // Correct the row to the real byte count rather than trusting the client's
    // declared size, which was only ever a pre-flight hint.
    const { prisma } = getContainer();
    const record = await prisma.attachment.findFirst({
      where: { storageKey: key, uploadedByUserId: actor.userId },
      select: { id: true },
    });
    if (record) {
      await prisma.attachment.update({
        where: { id: record.id },
        data: { sizeBytes: body.byteLength },
      });
    }

    return NextResponse.json({ ok: true as const, data: { bytes: body.byteLength } });
  });
}
