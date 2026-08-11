/**
 * Does this actually look like the image it claims to be?
 *
 * A declared `content-type` is a claim by the uploader, not a fact. The upload
 * route already checks the extension against the declared type, but both are
 * strings the client chose — neither says anything about the bytes.
 *
 * This reads the magic number instead, which is the only part of the file the
 * uploader cannot lie about without changing what the file *is*.
 *
 * ## Why it matters more for a photo than for an attachment
 *
 * Attachments are served `content-disposition: attachment`, precisely so that an
 * HTML or SVG file pretending to be a PNG cannot execute in our origin. A
 * profile photo is the opposite: it is rendered **inline** in an `<img>` on a
 * page a customer is looking at. So the guarantee that it is genuinely a raster
 * image has to come from somewhere, and this is that somewhere.
 *
 * Pure and dependency-free: no image library, no parsing, just the first few
 * bytes. Anything more would be a decoder, and a decoder is an attack surface.
 */

/** Signatures long enough to be unambiguous, short enough to need no parsing. */
const SIGNATURES: ReadonlyArray<{
  readonly contentType: string;
  readonly check: (bytes: Uint8Array) => boolean;
}> = [
  {
    contentType: "image/png",
    // \x89 P N G \r \n \x1a \n — the full 8-byte PNG signature.
    check: (b) =>
      b.length >= 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },
  {
    contentType: "image/jpeg",
    // SOI marker. Every JPEG starts FF D8 FF regardless of variant.
    check: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    contentType: "image/webp",
    // RIFF....WEBP — the size field sits between the two, so both are checked.
    check: (b) =>
      b.length >= 12 &&
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
  },
];

export type PhotoRejection =
  "EMPTY" | "TOO_LARGE" | "UNSUPPORTED_TYPE" | "NOT_AN_IMAGE" | "TYPE_MISMATCH";

export interface PhotoVerdict {
  readonly ok: boolean;
  readonly reason?: PhotoRejection;
  /** The type the bytes actually are, when they are a recognised image. */
  readonly detectedType?: string;
  readonly message?: string;
}

/**
 * Validates the uploaded bytes against the declared type and the size cap.
 *
 * Returns a verdict rather than throwing: an invalid upload is an expected
 * outcome the route turns into a 400, not an exceptional condition.
 */
export function validatePhotoBytes(params: {
  readonly bytes: Uint8Array;
  readonly declaredContentType: string;
  readonly maxBytes: number;
  readonly allowedTypes: readonly string[];
}): PhotoVerdict {
  const { bytes, declaredContentType, maxBytes, allowedTypes } = params;

  if (bytes.length === 0) {
    return { ok: false, reason: "EMPTY", message: "That file is empty." };
  }
  if (bytes.length > maxBytes) {
    return {
      ok: false,
      reason: "TOO_LARGE",
      message: `Images must be under ${String(Math.floor(maxBytes / (1024 * 1024)))} MB.`,
    };
  }
  if (!allowedTypes.includes(declaredContentType)) {
    return {
      ok: false,
      reason: "UNSUPPORTED_TYPE",
      message: "Use a PNG, JPEG or WebP image.",
    };
  }

  const detected = SIGNATURES.find((signature) => signature.check(bytes));

  if (!detected) {
    // The bytes are not any image we accept. Says nothing about what they *are*
    // — naming it would tell someone probing exactly what got through.
    return {
      ok: false,
      reason: "NOT_AN_IMAGE",
      message: "That file does not look like a PNG, JPEG or WebP image.",
    };
  }

  if (detected.contentType !== declaredContentType) {
    // Genuinely a raster image, but not the one it claimed. Usually a renamed
    // file rather than an attack — so the message is helpful, not accusing.
    return {
      ok: false,
      reason: "TYPE_MISMATCH",
      detectedType: detected.contentType,
      message: `That file is a ${detected.contentType.replace("image/", "").toUpperCase()}, not a ${declaredContentType.replace("image/", "").toUpperCase()}. Re-save it or rename it correctly.`,
    };
  }

  return { ok: true, detectedType: detected.contentType };
}
