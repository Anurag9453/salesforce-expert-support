import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * What the deployed function can actually see on disk.
 *
 * Temporary. Three attempts to get Prisma's query engine into a Vercel function
 * have failed, each on a different assumption about where files end up — a trace
 * include out of `node_modules`, then a copy into `.next/server`. Both looked
 * right locally. Rather than guess a fourth time, this asks the running function.
 *
 * Strictly read-only: `existsSync`, `readdirSync`, `statSync`. No writes, no
 * database access, nothing that changes state.
 *
 * Delete this once the engine loads. A permanent endpoint that lists filesystem
 * contents is not something to leave lying around, which is also why it is off
 * in production — see `runtimeDiagnosticsEnabled`.
 */

/**
 * Preview and local only.
 *
 * `VERCEL_ENV` is injected by the platform, so this needs no configuration —
 * which matters, because a diagnostic that depends on someone remembering to set
 * a variable is a diagnostic that will be off when it is needed.
 */
export function runtimeDiagnosticsEnabled(): boolean {
  return process.env.VERCEL_ENV === "preview" || process.env.NODE_ENV !== "production";
}

const MAX_ENTRIES = 12;

/** One line describing a path: missing, a file with its size, or a directory listing. */
function describe(path: string, filter?: (name: string) => boolean): string {
  try {
    if (!existsSync(path)) return "missing";
    const stat = statSync(path);
    if (stat.isFile()) return `file, ${(stat.size / 1024 / 1024).toFixed(1)} MB`;
    if (!stat.isDirectory()) return "exists, not a file or directory";

    const all = readdirSync(path);
    const matching = filter ? all.filter(filter) : all;
    if (matching.length === 0) {
      return `directory, ${String(all.length)} entries, none matching`;
    }
    const shown = matching.slice(0, MAX_ENTRIES).join(", ");
    const more =
      matching.length > MAX_ENTRIES ? ` … +${String(matching.length - MAX_ENTRIES)}` : "";
    return `directory: ${shown}${more}`;
  } catch (error) {
    // A permission error is itself an answer, so report rather than throw.
    return `unreadable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const isEngine = (name: string) => name.startsWith("libquery_engine-") && name.endsWith(".node");

/**
 * Every pnpm store directory holding a generated Prisma client.
 *
 * Scanned rather than resolved, because `require.resolve` answers "where would
 * this load from" and the question here is "what is actually on this disk".
 */
function pnpmClientDirs(root: string): string[] {
  const store = join(root, "node_modules", ".pnpm");
  try {
    if (!existsSync(store)) return [];
    return readdirSync(store)
      .filter((name) => name.startsWith("@prisma+client"))
      .map((name) => join(store, name, "node_modules", ".prisma", "client"));
  } catch {
    return [];
  }
}

export function collectRuntimeDiagnostics(): Record<string, string> {
  const cwd = process.cwd();
  const out: Record<string, string> = {
    cwd,
    /*
      Undefined in a bundled server chunk — the key silently vanished from the
      JSON the first time. Reported explicitly, because "the bundler did not give
      this module a directory" is itself a fact worth knowing when the question is
      where files sit relative to the code loading them.
    */
    routeDir: import.meta.dirname ?? "(unavailable in this bundle)",
    platform: `${process.platform}-${process.arch}`,
    vercelEnv: process.env.VERCEL_ENV ?? "(unset)",
  };

  /*
    Where Prisma itself said it looked, made concrete. On Vercel the function
    root is /var/task; locally these simply report missing, which is the correct
    answer and keeps the two environments comparable.
  */
  const candidates: Array<[string, string]> = [
    ["cwd/.next/server", join(cwd, ".next", "server")],
    ["cwd/.prisma/client", join(cwd, ".prisma", "client")],
    ["/var/task/apps/web/.next/server", "/var/task/apps/web/.next/server"],
    ["/var/task/apps/web/.prisma/client", "/var/task/apps/web/.prisma/client"],
    ["/tmp/prisma-engines", "/tmp/prisma-engines"],
  ];

  for (const [label, path] of candidates) {
    out[label] = describe(path, isEngine);
  }

  // The pnpm store, from both plausible roots.
  for (const root of [cwd, "/var/task", join(cwd, "..", "..")]) {
    const dirs = pnpmClientDirs(root);
    if (dirs.length === 0) continue;
    for (const dir of dirs) {
      out[dir.replace(root, `<${root}>`)] = describe(dir, isEngine);
    }
  }

  // And where the module system would load the client from, which is a different
  // question from where the files are — a mismatch between the two is exactly
  // the kind of thing that produces "could not locate the Query Engine".
  try {
    const require = createRequire(import.meta.url);
    const resolved: unknown = require.resolve("@prisma/client");
    /*
      Coerced, and checked, because inside a webpack bundle this is not a path.
      The bundler rewrites `require.resolve` to return its own numeric module id,
      which arrived here as a number despite the type saying string — and crashed
      the first reader of this output. A module id means the import was bundled
      rather than left external, which is a genuinely useful thing to learn.
    */
    out.resolvedPrismaClient =
      typeof resolved === "number"
        ? `webpack module id ${String(resolved)} — bundled, not an on-disk path`
        : String(resolved);
  } catch (error) {
    out.resolvedPrismaClient = `unresolvable: ${error instanceof Error ? error.message : "unknown"}`;
  }

  return out;
}
