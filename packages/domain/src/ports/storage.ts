/**
 * S3-compatible object storage (§7).
 *
 * No object is ever publicly readable. Downloads go through a short-TTL signed
 * URL issued only after a server-side authorization check (§30).
 */
export interface PresignedUpload {
  readonly url: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly storageKey: string;
  readonly expiresAt: Date;
}

export interface Storage {
  readonly name: string;
  presignUpload(params: {
    readonly key: string;
    readonly contentType: string;
    readonly maxSizeBytes: number;
    readonly ttlSeconds: number;
    /** Which endpoint receives the bytes; each object type validates differently. */
    readonly uploadPath?: string;
  }): Promise<PresignedUpload>;
  presignDownload(key: string, ttlSeconds: number, downloadPath?: string): Promise<string>;
  delete(key: string): Promise<void>;
}
