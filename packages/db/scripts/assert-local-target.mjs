/**
 * Refuses to let a destructive command run against anything but localhost.
 *
 * Guards `migrate:fresh`, which is `prisma migrate reset --force` — it drops
 * every table and every row without asking.
 *
 * This exists because the database target became configurable. While every
 * script hardcoded the local `.env`, "reset" could only ever destroy a
 * development database that is rebuilt from migrations in seconds. Now that
 * `ENV_FILE` can point anywhere, one absent-minded `ENV_FILE=../../.env.supabase
 * pnpm db:migrate:fresh` would drop production instead, and the flag that makes
 * it destructive is the same flag that stops Prisma asking whether you meant it.
 *
 * Localhost is the whole allow-list, deliberately. A hostname pattern for
 * "probably a dev database" is the kind of cleverness that eventually decides a
 * production host looks close enough.
 */

const url = process.env.DATABASE_URL;

if (!url) {
  console.error("assert-local-target: DATABASE_URL is not set — refusing to continue.");
  process.exit(1);
}

let host;
let port;
try {
  const parsed = new URL(url);
  host = parsed.hostname;
  port = parsed.port || "5432";
} catch {
  console.error("assert-local-target: DATABASE_URL is not a valid URL — refusing to continue.");
  process.exit(1);
}

const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

if (!LOCAL.has(host)) {
  console.error(
    [
      "",
      "  ✗ Refusing to run a destructive command against a non-local database.",
      "",
      `      target:   ${host}:${port}`,
      "      expected: localhost",
      "",
      "  `migrate:fresh` runs `prisma migrate reset --force`, which drops every",
      "  table and every row with no confirmation. It is meant for the embedded",
      "  local Postgres, which is rebuilt from migrations in seconds.",
      "",
      "  If you genuinely need to rebuild a remote database, do it deliberately",
      "  and not through a script whose name suggests a routine local reset.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(`  target is local (${host}:${port}) — destructive command allowed`);
