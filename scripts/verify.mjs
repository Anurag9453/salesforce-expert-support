#!/usr/bin/env node
/**
 * The Phase gate, as a command (§40).
 *
 * Runs everything the gate requires, in dependency order, and reports which
 * steps passed. Identical locally and in CI — the only difference is where
 * Postgres comes from.
 *
 *   pnpm verify            full run
 *   pnpm verify --quick    skip the database and boot checks
 *
 * Migrations are verified against a FRESH database, not the developer's
 * long-lived one. A migration set that only applies on top of accumulated
 * local state is not a migration set that works on deploy.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Read a single key out of the root .env, which the sub-scripts also use. */
function readEnvFile(key) {
  try {
    const line = readFileSync(join(ROOT, ".env"), "utf8")
      .split("\n")
      .find((l) => l.trim().startsWith(`${key}=`));
    return line
      ?.slice(line.indexOf("=") + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  } catch {
    return undefined;
  }
}
const QUICK = process.argv.includes("--quick");
const CI = process.env.CI === "true" || process.env.CI === "1";

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      env: { ...process.env, ...options.env },
      shell: false,
    });
    let output = "";
    if (options.capture) {
      child.stdout?.on("data", (d) => (output += d.toString()));
      child.stderr?.on("data", (d) => (output += d.toString()));
    }
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
    child.on("error", (error) => resolve({ code: 1, output: error.message }));
  });
}

const results = [];

async function step(name, fn) {
  const started = Date.now();
  process.stdout.write(`\n\x1b[1m▸ ${name}\x1b[0m\n`);
  const ok = await fn();
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  results.push({ name, ok, seconds });
  if (!ok) process.stdout.write(`\x1b[31m  ✗ ${name} failed\x1b[0m\n`);
  return ok;
}

// ── Static checks ────────────────────────────────────────────────────────────

await step("format", async () => (await run("pnpm", ["run", "format:check"])).code === 0);
await step("lint", async () => (await run("pnpm", ["turbo", "run", "lint"])).code === 0);
await step("typecheck", async () => (await run("pnpm", ["turbo", "run", "typecheck"])).code === 0);

// `test` runs in one of two places depending on mode.
//
// `--quick` promises static checks and no database, so it runs the suite here and
// accepts that the database-backed concurrency test cannot participate. A full
// run defers it until after Postgres is confirmed up — see the longer note there.
if (QUICK) {
  await step("test (no database — DB-backed suites excluded)", async () => {
    return (
      (await run("pnpm", ["turbo", "run", "test"], { env: { SKIP_DB_TESTS: "1" } })).code === 0
    );
  });
}

// ── Database + boot checks ───────────────────────────────────────────────────

let postgres; // Only set when THIS process started the server, so only this
// process stops it. Awaiting stop() on a server we did not start
// hangs forever and Node then exits 0 with the report unprinted.

async function canConnect(url) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

if (!QUICK) {
  const configuredUrl = process.env.DATABASE_URL ?? readEnvFile("DATABASE_URL");

  if (!CI) {
    // CI provides Postgres as a service container; locally we bring our own.
    await step("local postgres available", async () => {
      if (await canConnect(configuredUrl)) {
        process.stdout.write("  already running\n");
        return true;
      }
      const { default: EmbeddedPostgres } = await import("embedded-postgres");
      const { existsSync } = await import("node:fs");
      const dataDir = join(ROOT, ".pgdata");
      const instance = new EmbeddedPostgres({
        databaseDir: dataDir,
        user: "sfx",
        password: "sfx_local_dev",
        port: 55432,
        persistent: true,
        onLog: () => {},
      });
      try {
        if (!existsSync(dataDir)) {
          await instance.initialise();
          await instance.start();
          await instance.createDatabase("sfx");
        } else {
          await instance.start();
        }
        postgres = instance;
        process.stdout.write("  started\n");
        return true;
      } catch (error) {
        process.stdout.write(`  ${error}\n`);
        return false;
      }
    });
  }

  /**
   * Unit and integration tests, once a database exists.
   *
   * This deliberately runs *after* the Postgres step rather than alongside the
   * other static checks. Phase 5 added a concurrency test that talks to a real
   * database — the `one_open_offer_per_expert` partial unique index cannot be
   * tested any other way — and with `test` running before Postgres was started,
   * that suite failed whenever the server happened not to already be up. It
   * passed for weeks because it always was.
   *
   * The alternative was to let the suite skip itself when it cannot connect,
   * which is worse: a gate that silently omits its most important assertion
   * reads exactly like a gate that passed.
   */
  await step("test", async () => (await run("pnpm", ["turbo", "run", "test"])).code === 0);

  /**
   * "Migrations apply to a fresh database" — proven WITHOUT destroying anything.
   *
   * `prisma migrate reset` would drop the developer's database, and Prisma now
   * refuses that when it detects an AI agent driving it (correctly). We don't
   * need it: creating a throwaway database and migrating into that proves the
   * same property — that the migration set stands on its own rather than only
   * applying on top of accumulated local state — and touches no real data.
   */
  await step("migrations apply to a fresh database", async () => {
    const { default: pg } = await import("pg");
    const suffix = process.hrtime.bigint().toString(36).slice(-8);
    const scratchName = `sfx_verify_${suffix}`;
    const admin = new URL(configuredUrl);
    admin.pathname = "/postgres";
    const scratchUrl = new URL(configuredUrl);
    scratchUrl.pathname = `/${scratchName}`;

    const client = new pg.Client({ connectionString: admin.toString() });
    let created = false;
    try {
      await client.connect();
      await client.query(`CREATE DATABASE "${scratchName}"`);
      created = true;
      process.stdout.write(`  created scratch database ${scratchName}\n`);

      const scratchEnv = {
        DATABASE_URL: scratchUrl.toString(),
        DIRECT_DATABASE_URL: scratchUrl.toString(),
      };

      const deployed = await run("pnpm", ["--filter", "@sfx/db", "run", "migrate:deploy"], {
        env: scratchEnv,
      });
      if (deployed.code !== 0) return false;

      const asserted = await run("pnpm", ["--filter", "@sfx/db", "run", "assert-schema"], {
        env: scratchEnv,
      });
      if (asserted.code !== 0) return false;

      const seeded = await run("pnpm", ["--filter", "@sfx/db", "run", "seed"], {
        env: scratchEnv,
      });
      return seeded.code === 0;
    } catch (error) {
      process.stdout.write(`  ${error}\n`);
      return false;
    } finally {
      if (created) {
        // Safe to drop: this database was created seconds ago by this run and
        // has never held anything but the migration output.
        await client.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => {});
        process.stdout.write(`  dropped scratch database ${scratchName}\n`);
      }
      await client.end().catch(() => {});
    }
  });

  await step("dev database is migrated and seeded", async () => {
    const deployed = await run("pnpm", ["--filter", "@sfx/db", "run", "migrate:deploy"]);
    if (deployed.code !== 0) return false;
    const asserted = await run("pnpm", ["--filter", "@sfx/db", "run", "assert-schema"]);
    if (asserted.code !== 0) return false;
    return (await run("pnpm", ["--filter", "@sfx/db", "run", "seed"])).code === 0;
  });

  await step(
    "web builds",
    async () => (await run("pnpm", ["--filter", "@sfx/web", "run", "build"])).code === 0,
  );

  await step("worker boots", async () => {
    const result = await run("pnpm", ["--filter", "@sfx/worker", "run", "start"], {
      capture: true,
      env: { WORKER_BOOT_CHECK: "1" },
    });
    if (result.code !== 0) process.stdout.write(result.output);
    else process.stdout.write("  registered queues, reached the database, shut down cleanly\n");
    return result.code === 0;
  });
}

if (postgres) {
  // Bounded: a hung stop() must not swallow the report (it did exactly that once).
  await Promise.race([
    postgres.stop().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
}

// ── Report ───────────────────────────────────────────────────────────────────

const width = Math.max(...results.map((r) => r.name.length)) + 2;
process.stdout.write("\n\x1b[1m── verify ──\x1b[0m\n");
for (const { name, ok, seconds } of results) {
  const mark = ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  process.stdout.write(`  ${mark} ${name.padEnd(width)}${seconds}s\n`);
}

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  process.stdout.write(`\n\x1b[31m${failed.length} step(s) failed\x1b[0m\n`);
  process.exit(1);
}
process.stdout.write(`\n\x1b[32mall ${results.length} steps passed\x1b[0m\n`);
