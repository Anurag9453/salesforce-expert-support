import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import type { PresignedUpload, Storage } from "@sfx/domain";

/**
 * Filesystem-backed Storage for local development.
 *
 * Shaped exactly like the S3/R2 adapter it will be replaced by (§7): presigned
 * upload, presigned download, private objects. Swapping in R2 is a change in the
 * composition root, nothing else.
 *
 * It keeps the two security properties that matter, rather than being a
 * convenient stub that drops them:
 *
 * 1. **Signed, expiring URLs.** An HMAC over key + expiry, verified on use, so
 *    the download route cannot be turned into an arbitrary file reader by
 *    editing a query string.
 * 2. **Path containment.** Every resolved path is checked to be inside the root.
 *    A storage key is model- and client-influenced data, and `../` in one must
 *    not escape (§30).
 */
export interface LocalStorageOptions {
  readonly rootDir: string;
  /** Signs URLs. In dev this is derived from BETTER_AUTH_SECRET. */
  readonly signingSecret: string;
  /** Route that serves signed downloads/uploads. */
  readonly baseUrl: string;
}

export class LocalFileStorage implements Storage {
  readonly name = "local";

  constructor(private readonly options: LocalStorageOptions) {}

  /**
   * Rejects any key that escapes the root once resolved. Checked with a
   * separator-aware prefix test so `/data/storage-evil` cannot pass as being
   * inside `/data/storage`.
   */
  private resolveKey(key: string): string {
    const root = resolve(this.options.rootDir);
    const target = resolve(join(root, normalize(key)));
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`Storage key escapes the root: ${key}`);
    }
    return target;
  }

  private sign(key: string, expiresAtMs: number): string {
    return createHmac("sha256", this.options.signingSecret)
      .update(`${key}:${expiresAtMs}`)
      .digest("base64url");
  }

  /** Constant-time, and never throws on a malformed signature. */
  verify(key: string, expiresAtMs: number, signature: string): boolean {
    if (!Number.isFinite(expiresAtMs) || expiresAtMs < Date.now()) return false;
    const expected = this.sign(key, expiresAtMs);
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  async presignUpload(params: {
    key: string;
    contentType: string;
    maxSizeBytes: number;
    ttlSeconds: number;
  }): Promise<PresignedUpload> {
    const expiresAtMs = Date.now() + params.ttlSeconds * 1000;
    const signature = this.sign(params.key, expiresAtMs);
    const url = new URL(`${this.options.baseUrl}/api/v1/attachments/upload`);
    url.searchParams.set("key", params.key);
    url.searchParams.set("expires", String(expiresAtMs));
    url.searchParams.set("signature", signature);

    return {
      url: url.toString(),
      fields: { "content-type": params.contentType },
      storageKey: params.key,
      expiresAt: new Date(expiresAtMs),
    };
  }

  async presignDownload(key: string, ttlSeconds: number): Promise<string> {
    const expiresAtMs = Date.now() + ttlSeconds * 1000;
    const url = new URL(`${this.options.baseUrl}/api/v1/attachments/download`);
    url.searchParams.set("key", key);
    url.searchParams.set("expires", String(expiresAtMs));
    url.searchParams.set("signature", this.sign(key, expiresAtMs));
    return url.toString();
  }

  async put(key: string, body: Buffer): Promise<void> {
    const path = this.resolveKey(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.resolveKey(key));
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.resolveKey(key));
    } catch (error) {
      // Already gone is the desired end state.
      if ((error as { code?: string }).code !== "ENOENT") throw error;
    }
  }
}

/**
 * Storage keys are generated server-side and never taken from the client.
 * The customer's filename is metadata only — it never becomes part of the path,
 * which removes filename-driven traversal entirely rather than sanitising it.
 */
export function buildAttachmentKey(userId: string, filename: string): string {
  const extension = filename.includes(".")
    ? `.${
        filename
          .split(".")
          .pop()
          ?.toLowerCase()
          .replace(/[^a-z0-9]/g, "") ?? ""
      }`
    : "";
  return `attachments/${userId}/${randomUUID()}${extension}`;
}
