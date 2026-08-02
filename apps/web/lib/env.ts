import { parseClientEnv, parseServerEnv, type ClientEnv, type ServerEnv } from "@sfx/contracts";

/**
 * Boot-time environment validation (§30).
 *
 * A missing secret fails here with a readable message, not later as a null
 * dereference in a request handler.
 *
 * `serverEnv()` is lazy so importing this module from a client component tree
 * during the build does not attempt to read server-only variables.
 */

let cachedServer: ServerEnv | undefined;

export function serverEnv(): ServerEnv {
  if (typeof window !== "undefined") {
    throw new Error(
      "serverEnv() was called in the browser. Server secrets must never reach the client bundle (§30).",
    );
  }
  cachedServer ??= parseServerEnv(process.env);
  return cachedServer;
}

/**
 * Client variables are read from an explicit literal object, not `process.env`
 * dynamically — Next.js only inlines statically analysable references.
 */
export const clientEnv: ClientEnv = parseClientEnv({
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
});
