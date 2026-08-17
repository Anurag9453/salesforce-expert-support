/**
 * Compares a migrated database against a known-good one, and reports seed state.
 *
 * Read-only. Written for the Supabase migration, where "did the eighteen
 * migrations produce the same schema as the database I have been developing
 * against?" is the only question that matters, and counting tables by eye does
 * not answer it. Structure is diffed rather than asserted against hardcoded
 * numbers, so this does not rot the next time a migration lands.
 *
 * Usage: node db-verify.mjs <target-env-file> [baseline-env-file]
 */
import { readFileSync } from "node:fs";
import { Client } from "pg";

const [targetFile, baselineFile] = process.argv.slice(2);
if (!targetFile) {
  console.error("usage: node db-verify.mjs <target-env-file> [baseline-env-file]");
  process.exit(2);
}

const readEnv = (file) =>
  Object.fromEntries(
    readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
      }),
  );

/** Everything worth comparing, in one round trip per database. */
async function describe(connectionString) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const q = async (sql) => (await client.query(sql)).rows;

    const [{ version }] = await q("SELECT version()");
    const tables = (
      await q(`SELECT table_name FROM information_schema.tables
                WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
                ORDER BY 1`)
    ).map((r) => r.table_name);
    const pgboss = (
      await q(`SELECT count(*)::int n FROM information_schema.tables
                WHERE table_schema = 'pgboss' AND table_type = 'BASE TABLE'`)
    )[0].n;

    // Enum values matter as much as enum names: a migration that adds
    // CERTIFICATION and one that does not both leave 26 enums behind.
    const enums = {};
    for (const row of await q(`SELECT t.typname, e.enumlabel
                                 FROM pg_type t
                                 JOIN pg_enum e ON e.enumtypid = t.oid
                                 JOIN pg_namespace n ON n.oid = t.typnamespace
                                WHERE n.nspname = 'public'
                                ORDER BY t.typname, e.enumsortorder`)) {
      (enums[row.typname] ??= []).push(row.enumlabel);
    }

    // The partial unique indexes are this schema's invariants, not decoration —
    // they are what makes "one open offer per expert" true under concurrency.
    const indexes = (
      await q(`SELECT indexname FROM pg_indexes
                WHERE schemaname = 'public' AND indexdef LIKE '%WHERE%'
                ORDER BY 1`)
    ).map((r) => r.indexname);

    const migrations = await q(
      `SELECT migration_name, finished_at, rolled_back_at
         FROM _prisma_migrations ORDER BY migration_name`,
    ).catch(() => null);

    const counts = {};
    for (const t of ["categories", "skills", "pricing_tiers", "platform_configuration",
                     "users", "support_leads", "support_requests", "expert_profiles"]) {
      if (!tables.includes(t)) continue;
      counts[t] = Number((await q(`SELECT count(*)::int n FROM "${t}"`))[0].n);
    }

    return { version: version.split(" on ")[0], tables, pgboss, enums, indexes, migrations, counts };
  } finally {
    await client.end().catch(() => undefined);
  }
}

const targetEnv = readEnv(targetFile);
const target = await describe(targetEnv.DIRECT_DATABASE_URL ?? targetEnv.DATABASE_URL);

console.log("── target ──");
console.log(`  ${target.version}`);
console.log(`  public: ${target.tables.length} tables   pgboss: ${target.pgboss} tables`);
console.log(`  enums: ${Object.keys(target.enums).length}   partial indexes: ${target.indexes.length}`);

console.log("── migrations ──");
if (!target.migrations) {
  console.log("  ✗ no _prisma_migrations table — nothing has been migrated");
} else {
  const unfinished = target.migrations.filter((m) => !m.finished_at);
  const rolledBack = target.migrations.filter((m) => m.rolled_back_at);
  console.log(`  ${target.migrations.length} recorded`);
  console.log(`  first ${target.migrations[0]?.migration_name}`);
  console.log(`  last  ${target.migrations.at(-1)?.migration_name}`);
  if (unfinished.length) console.log(`  ✗ unfinished: ${unfinished.map((m) => m.migration_name).join(", ")}`);
  if (rolledBack.length) console.log(`  ✗ rolled back: ${rolledBack.map((m) => m.migration_name).join(", ")}`);
  if (!unfinished.length && !rolledBack.length) console.log("  ✓ all applied cleanly");
}

console.log("── row counts ──");
for (const [t, n] of Object.entries(target.counts)) console.log(`  ${String(n).padStart(5)}  ${t}`);

let failures = 0;
if (baselineFile) {
  const baseEnv = readEnv(baselineFile);
  const base = await describe(baseEnv.DIRECT_DATABASE_URL ?? baseEnv.DATABASE_URL);

  console.log(`\n── structural diff against the baseline (${base.version}) ──`);
  const diffSet = (label, a, b) => {
    const missing = b.filter((x) => !a.includes(x));
    const extra = a.filter((x) => !b.includes(x));
    if (!missing.length && !extra.length) { console.log(`  ✓ ${label} identical (${a.length})`); return; }
    failures += 1;
    if (missing.length) console.log(`  ✗ ${label} missing from target: ${missing.join(", ")}`);
    if (extra.length) console.log(`  ✗ ${label} only in target: ${extra.join(", ")}`);
  };

  diffSet("tables", target.tables, base.tables);
  diffSet("partial indexes", target.indexes, base.indexes);
  diffSet("enum names", Object.keys(target.enums), Object.keys(base.enums));

  let enumDrift = 0;
  for (const [name, values] of Object.entries(base.enums)) {
    const mine = target.enums[name];
    if (!mine) continue;
    if (mine.join("|") !== values.join("|")) {
      enumDrift += 1; failures += 1;
      console.log(`  ✗ enum ${name}: target [${mine.join(", ")}] vs baseline [${values.join(", ")}]`);
    }
  }
  if (!enumDrift) console.log(`  ✓ every enum has the same values in the same order`);

  if (target.pgboss !== base.pgboss) {
    console.log(`  ! pgboss tables: ${target.pgboss} vs ${base.pgboss} — expected until the worker has booted once`);
  } else {
    console.log(`  ✓ pgboss schema present (${target.pgboss} tables)`);
  }
}

console.log(`\n${failures} structural difference(s)`);
process.exit(failures > 0 ? 1 : 0);
