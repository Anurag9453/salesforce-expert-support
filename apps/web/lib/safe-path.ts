/**
 * Relative in-app path only. Anything else is dropped so a `next` query cannot
 * send the browser off-site after sign-in.
 */
export function safeInternalPath(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return fallback;
  }
  return value;
}
