import { describe, expect, it } from "vitest";
import { validatePhotoBytes } from "./photo-validation.js";

const ALLOWED = ["image/png", "image/jpeg", "image/webp"];
const MAX = 5 * 1024 * 1024;

/** Real magic numbers, padded to a plausible length. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(40).fill(0)]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array(40).fill(0)]);
const WEBP = new Uint8Array([
  0x52,
  0x49,
  0x46,
  0x46,
  0x24,
  0x00,
  0x00,
  0x00,
  0x57,
  0x45,
  0x42,
  0x50,
  ...Array(40).fill(0),
]);

function check(bytes: Uint8Array, declaredContentType: string, maxBytes = MAX) {
  return validatePhotoBytes({ bytes, declaredContentType, maxBytes, allowedTypes: ALLOWED });
}

describe("valid images", () => {
  it("accepts a PNG whose bytes match its declared type", () => {
    const verdict = check(PNG, "image/png");
    expect(verdict.ok).toBe(true);
    expect(verdict.detectedType).toBe("image/png");
  });

  it("accepts a JPEG", () => {
    expect(check(JPEG, "image/jpeg").ok).toBe(true);
  });

  it("accepts a WebP, checking both RIFF and WEBP around the size field", () => {
    expect(check(WEBP, "image/webp").ok).toBe(true);
  });
});

describe("rejections", () => {
  it("rejects an empty file", () => {
    expect(check(new Uint8Array([]), "image/png").reason).toBe("EMPTY");
  });

  it("rejects a file over the size cap", () => {
    const big = new Uint8Array(MAX + 1);
    big.set(PNG.slice(0, 8));
    const verdict = check(big, "image/png");
    expect(verdict.reason).toBe("TOO_LARGE");
    expect(verdict.message).toContain("5 MB");
  });

  it("rejects a type that is not on the allow-list", () => {
    // GIF and SVG are excluded on purpose — see the contract comment.
    expect(check(PNG, "image/gif").reason).toBe("UNSUPPORTED_TYPE");
    expect(check(PNG, "image/svg+xml").reason).toBe("UNSUPPORTED_TYPE");
  });

  it("rejects HTML wearing a PNG content-type", () => {
    // The attack this exists to stop: a profile photo is rendered inline, so a
    // file that is really markup would execute in our origin.
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    const verdict = check(html, "image/png");
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("NOT_AN_IMAGE");
  });

  it("rejects an SVG wearing a PNG content-type", () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(check(svg, "image/png").reason).toBe("NOT_AN_IMAGE");
  });

  it("does not name what the file actually was when it is not an image", () => {
    // Telling a prober "that is a ZIP" is telling them what got as far as the
    // sniffer. The message stays generic.
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...Array(20).fill(0)]);
    const verdict = check(zip, "image/png");
    expect(verdict.detectedType).toBeUndefined();
    expect(verdict.message).not.toMatch(/zip/i);
  });

  it("catches a genuine image renamed to the wrong extension", () => {
    // A JPEG uploaded as .png — usually a mistake, so the message is helpful.
    const verdict = check(JPEG, "image/png");
    expect(verdict.reason).toBe("TYPE_MISMATCH");
    expect(verdict.detectedType).toBe("image/jpeg");
    expect(verdict.message).toContain("JPEG");
  });

  it("rejects a truncated file that only starts to look like a PNG", () => {
    expect(check(new Uint8Array([0x89, 0x50, 0x4e]), "image/png").ok).toBe(false);
  });

  it("rejects RIFF that is not WebP", () => {
    // A WAV file is also RIFF. The bytes after the size field are what decide.
    const wav = new Uint8Array([
      0x52,
      0x49,
      0x46,
      0x46,
      0x24,
      0x00,
      0x00,
      0x00,
      0x57,
      0x41,
      0x56,
      0x45,
      ...Array(20).fill(0),
    ]);
    expect(check(wav, "image/webp").reason).toBe("NOT_AN_IMAGE");
  });

  it("never throws, whatever it is handed", () => {
    for (const bytes of [new Uint8Array([0]), new Uint8Array(3), PNG.slice(0, 1)]) {
      expect(() => check(bytes, "image/png")).not.toThrow();
    }
  });
});
