/**
 * Read-only preflight for a database target. Runs no DDL, writes nothing.
 *
 * Exists because "point Prisma at the new database" has three failure modes that
 * all look like success until much later: migrating the wrong database, giving
 * the worker a pooled URL, and connecting as a role that cannot create the
 * schema pg-boss needs. Each is cheap to check now and expensive to discover
 * from a symptom.
 *
 * Usage: node preflight.mjs <env-file>
 */
import { readFileSync } from "node:fs";
import { Client } from "pg";

const envFile = process.argv[2];
if (!envFile) {
  console.error("usage: node preflight.mjs <env-file>");
  process.exit(2);
}

const env = Object.fromEntries(
  readFileSync(envFile, "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);

const ROLES = [
  { name: "DATABASE_URL", expect: "pooled", used: "web app queries" },
  { name: "DIRECT_DATABASE_URL", expect: "direct", used: "migrations + realtime LISTEN" },
  { name: "WORKER_DATABASE_URL", expect: "direct", used: "worker / pg-boss" },
];

let failures = 0;
let warnings = 0;
const fail = (m) => { console.log(`  ✗ ${m}`); failures += 1; };
const warn = (m) => { console.log(`  ! ${m}`); warnings += 1; };
const ok = (m) => console.log(`  ✓ ${m}`);

// ── 1. Shape of each URL, without connecting ─────────────────────────────────
console.log("── the three URLs ──");
const parsed = {};
for (const role of ROLES) {
  const raw = env[role.name];
  if (!raw) { fail(`${role.name} is missing`); continue; }
  let u;
  try { u = new URL(raw); } catch { fail(`${role.name} is not a valid URL`); continue; }
  parsed[role.name] = { url: u, raw };
  const db = u.pathname.replace(/^\//, "");
  console.log(`  ${role.name}`);
  console.log(`      host ${u.hostname}  port ${u.port || "5432"}  db ${db}  user ${decodeURIComponent(u.username)}`);
  console.log(`      → ${role.used}`);

  // Never migrate or seed the local development database by accident.
  if (/^(localhost|127\.0\.0\.1|::1)$/.test(u.hostname)) {
    fail(`${role.name} points at localhost — this is the local dev database, not Supabase`);
  }
  if (u.port === "55432") {
    fail(`${role.name} is on 55432, the embedded local Postgres`);
  }

  const port = u.port || "5432";
  if (role.expect === "pooled" && port !== "6543") {
    warn(`${role.name} is on ${port}, not 6543 — expected the transaction pooler`);
  }
  if (role.expect === "direct" && port === "6543") {
    fail(`${role.name} is on 6543 (the transaction pooler) but must be a direct connection — a pooler cannot hold LISTEN or an advisory lock`);
  }
  if (role.name === "DATABASE_URL" && port === "6543" && !/pgbouncer=true/.test(raw)) {
    warn("DATABASE_URL is pooled but lacks ?pgbouncer=true — Prisma needs it to disable prepared statements");
  }
  if (!/sslmode=/.test(raw)) {
    warn(`${role.name} does not set sslmode — Supabase requires TLS; sslmode=require is the safe default`);
  }
}

// All three must be the same database, or the app and worker disagree about reality.
const dbNames = new Set(
  Object.values(parsed).map((p) => p.url.pathname.replace(/^\//, "")),
);
const hosts = new Set(Object.values(parsed).map((p) => p.url.hostname.replace(/^aws-\d+-/, "")));
console.log("── consistency ──");
if (dbNames.size > 1) fail(`the three URLs name different databases: ${[...dbNames].join(", ")}`);
else ok(`all three name the same database (${[...dbNames][0] ?? "?"})`);
if (hosts.size > 1) warn(`hostnames differ beyond the pooler prefix: ${[...hosts].join(", ")} — expected for Supabase's pooler, worth an eye`);

// ── 2. Connect on the direct URL only, and only to read ──────────────────────
const direct = parsed.DIRECT_DATABASE_URL?.raw;
if (!direct) {
  console.log("\nCannot inspect the server: DIRECT_DATABASE_URL is unusable.");
  process.exit(1);
}

console.log("── the server (read-only) ──");
/*
  TLS is left to the connection string's own `sslmode`, deliberately.

  An earlier version passed `ssl: { rejectUnauthorized: false }` unconditionally.
  That broke against the local server, which speaks no TLS at all — and worse, it
  would have silently disabled certificate verification against the production
  one, turning "encrypted" into "encrypted to whoever answered". Supabase presents
  a certificate from a public CA, so ordinary verification succeeds; a URL that
  needs `sslmode=require` should say so, and the check above warns when it does not.
*/
const client = new Client({ connectionString: direct });
try {
  await client.connect();
  const one = async (sql) => (await client.query(sql)).rows[0];

  const v = await one("SELECT version(), current_database() db, current_user usr");
  ok(`connected — ${v.version.split(" on ")[0]}`);
  console.log(`      database ${v.db}, role ${v.usr}`);

  // pg-boss creates its own schema at boot. Without CREATE the worker dies with
  // a permission error that reads like a bug in the queue library.
  const priv = await one(
    "SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS can_create",
  );
  if (priv.can_create) ok("the role may CREATE — pg-boss can make its pgboss schema");
  else fail("the role cannot CREATE in this database — pg-boss will fail at boot");

  // Is this actually a clean database? A non-empty public schema means either the
  // migration already ran or we are pointed somewhere in use.
  const tables = await client.query(
    `SELECT table_schema s, count(*)::int n
       FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        AND table_schema NOT IN ('pg_catalog','information_schema')
      GROUP BY 1 ORDER BY 1`,
  );
  console.log("── what is already there ──");
  if (tables.rows.length === 0) ok("no user tables at all — a clean database");
  for (const r of tables.rows) {
    const note = r.s === "public" && r.n > 0 ? "  ← already populated" : "";
    console.log(`      ${r.s}: ${r.n} tables${note}`);
  }
  const applied = await client
    .query(`SELECT count(*)::int n FROM _prisma_migrations`)
    .catch(() => ({ rows: [{ n: null }] }));
  console.log(
    applied.rows[0].n === null
      ? "      _prisma_migrations: absent (nothing has been migrated here)"
      : `      _prisma_migrations: ${applied.rows[0].n} rows`,
  );
} catch (error) {
  fail(`could not connect on DIRECT_DATABASE_URL: ${error.message}`);
} finally {
  await client.end().catch(() => undefined);
}

console.log(`\n${failures} blocking, ${warnings} to look at`);
process.exit(failures > 0 ? 1 : 0);
