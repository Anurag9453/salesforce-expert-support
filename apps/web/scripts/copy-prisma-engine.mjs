/**
 * Copies Prisma's query engine into `.next/server/` after a build.
 *
 * ## Why this is here rather than handled by tracing
 *
 * The engine is a native binary that Prisma opens by path at runtime. Nothing
 * imports it, so Next's file tracer cannot see it, and `outputFileTracingIncludes`
 * — which does work for a plain directory like `certs/` — did not carry it out of
 * the pnpm virtual store. Two deployments failed at runtime with
 * "could not locate the Query Engine for runtime rhel-openssl-3.0.x" while the
 * build itself reported success, once with a warm cache and once with a cold one.
 *
 * `.next/server/` is the target because Prisma's own error names it:
 *
 *     The following locations have been searched:
 *       /var/task/node_modules/.pnpm/@prisma+client@…/node_modules/.prisma/client
 *       /var/task/apps/web/.next/server          ← this one
 *       …
 *
 * It is also Next's own build output, which every host ships wholesale. So this
 * depends on nothing beyond "the build output is deployed", rather than on glob
 * semantics, symlink following, or how a platform assembles a function.
 *
 * ## Why it fails the build rather than warning
 *
 * A missing engine is not degraded — it is every database query throwing, which
 * on this site means the intake form is a 500. That is worth failing a build for,
 * and much cheaper to notice here than from a deployed health check.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

/**
 * Where `prisma generate` puts the client, found by resolution rather than by a
 * hardcoded path — pnpm's layout embeds version hashes that change on every
 * upgrade, and a glob for them is a thing that breaks silently later.
 *
 * Resolved from `packages/db`, not from here. `@prisma/client` is a dependency
 * of that package and not of the web app, and pnpm's node_modules are strict:
 * asking from the wrong directory gets "Cannot find module", which is the
 * correct answer to a question about a dependency the app does not declare.
 */
function generatedClientDir() {
  const requireFromDb = createRequire(join(repoRoot, "packages", "db", "package.json"));
  const marker = `${"node_modules"}/`;
  const entry = requireFromDb.resolve("@prisma/client");
  const index = entry.lastIndexOf(marker);
  if (index === -1) {
    throw new Error(`could not locate node_modules from ${entry}`);
  }
  return join(entry.slice(0, index + marker.length), ".prisma", "client");
}

const source = generatedClientDir();
const destination = join(dirname(import.meta.dirname), ".next", "server");

if (!existsSync(source)) {
  console.error(
    `\n  ✗ Prisma client not generated — expected ${source}\n` +
      `    Run \`pnpm --filter @sfx/db run generate\` before building.\n`,
  );
  process.exit(1);
}

const engines = readdirSync(source).filter(
  (name) => name.startsWith("libquery_engine-") && name.endsWith(".node"),
);

if (engines.length === 0) {
  console.error(
    `\n  ✗ No query engine found in ${source}\n` +
      `    Check \`binaryTargets\` in packages/db/prisma/schema.prisma — without\n` +
      `    the deployment target listed, Prisma builds only for this machine.\n`,
  );
  process.exit(1);
}

mkdirSync(destination, { recursive: true });

/*
  Every engine present, not just the deployment target. The build machine's own
  engine is what `next start` uses locally, and picking one here would mean
  guessing which environment this build is destined for. A few unused megabytes
  is a better trade than a build that only works in one place.
*/
for (const engine of engines) {
  copyFileSync(join(source, engine), join(destination, engine));
  const size = statSync(join(destination, engine)).size;
  console.log(`  copied ${engine} (${(size / 1024 / 1024).toFixed(1)} MB) → .next/server/`);
}
