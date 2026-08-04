#!/usr/bin/env node
/**
 * Local Postgres without Docker or a system-wide install.
 *
 * `embedded-postgres` downloads a real Postgres binary into the project and
 * runs it on demand against a gitignored data directory. No brew service, no
 * container runtime, nothing mutated outside this repo — and CI gets the same
 * schema through a standard Postgres service container.
 *
 *   node scripts/local-postgres.mjs start|stop|reset|status
 */
import EmbeddedPostgres from "embedded-postgres";
import { rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, ".pgdata");

export const PG = {
  user: "sfx",
  password: "sfx_local_dev",
  host: "localhost",
  port: 55432, // Deliberately not 5432, so a real local Postgres is never touched.
  database: "sfx",
};

export const LOCAL_DATABASE_URL = `postgresql://${PG.user}:${PG.password}@${PG.host}:${PG.port}/${PG.database}`;

function instance() {
  return new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: PG.user,
    password: PG.password,
    port: PG.port,
    persistent: true,
    onLog: () => {}, // Postgres is chatty at boot; failures still surface as throws.
    onError: (message) => process.stderr.write(`postgres: ${message}\n`),
  });
}

/**
 * Is something already serving on our port?
 *
 * Checked before trying to start, because `pnpm pg:start` is the first command
 * anyone runs and "it is already running" is not a failure — it is the state you
 * wanted. Without this, a second `pg:start` (a forgotten terminal, a rerun after
 * a scrollback clear) fails with a port collision, which reads like a broken
 * setup on someone's first five minutes.
 */
async function alreadyRunning() {
  const { default: pg } = await import("pg");
  const client = new pg.Client({
    connectionString: LOCAL_DATABASE_URL,
    connectionTimeoutMillis: 1500,
  });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    await client.end().catch(() => undefined);
    return false;
  }
}

async function start({ quiet = false } = {}) {
  const pg = instance();
  const fresh = !existsSync(DATA_DIR);

  if (fresh) {
    if (!quiet) console.log("initialising cluster (first run downloads the binary)…");
    await mkdir(DATA_DIR, { recursive: true });
    await pg.initialise();
  }

  await pg.start();

  if (fresh) {
    await pg.createDatabase(PG.database);
  }

  if (!quiet) {
    console.log(`postgres up on port ${PG.port}`);
    console.log(`DATABASE_URL=${LOCAL_DATABASE_URL}`);
  }
  return pg;
}

async function stop() {
  try {
    await instance().stop();
    console.log("postgres stopped");
  } catch {
    console.log("postgres was not running");
  }
}

async function reset() {
  await stop();
  await rm(DATA_DIR, { recursive: true, force: true });
  console.log("data directory removed");
  const pg = await start();
  await pg.stop();
  console.log("cluster reinitialised");
}

/**
 * Reports both facts, because they are different and both matter.
 *
 * "A cluster exists on disk" and "a server is answering" are independent, and
 * only the second one is what someone means when they ask whether Postgres is
 * up. Reporting only the first sent people looking in the wrong place.
 */
async function status() {
  const initialised = existsSync(DATA_DIR);
  const running = await alreadyRunning();

  console.log(initialised ? `cluster:  present at ${DATA_DIR}` : "cluster:  not initialised");
  console.log(running ? `server:   running on port ${PG.port}` : "server:   not running");

  if (!initialised) console.log("\nnext:     pnpm pg:start   (first run downloads a binary)");
  else if (!running) console.log("\nnext:     pnpm pg:start");
  else console.log("\nnext:     pnpm db:setup && pnpm dev");
}

const command = process.argv[2] ?? "start";

const run = {
  start: async () => {
    if (await alreadyRunning()) {
      // Idempotent on purpose. Exits 0 — you asked for a running server and
      // there is one.
      console.log(`postgres is already running on port ${PG.port}`);
      console.log(`DATABASE_URL=${LOCAL_DATABASE_URL}`);
      console.log("\nnothing to do — leave this terminal free and carry on with:");
      console.log("  pnpm db:setup && pnpm dev");
      console.log(`\n(to take it down: pnpm pg:stop)`);
      return;
    }

    const pg = await start();
    // `start` is used interactively; hold the process so the server stays up.
    if (process.env.PG_DETACH === "1") {
      await pg.stop();
      return;
    }
    console.log("ctrl-c to stop");
    process.on("SIGINT", () => void pg.stop().then(() => process.exit(0)));
    await new Promise(() => {});
  },
  stop,
  reset,
  status,
}[command];

if (!run) {
  console.error(`unknown command: ${command}\nusage: start | stop | reset | status`);
  process.exit(1);
}

run().catch(async (error) => {
  // `embedded-postgres` can reject with a non-Error — sometimes with nothing at
  // all — and `console.error(undefined)` prints the word "undefined" and no more.
  // That was the entire diagnostic on a first-run port collision.
  const detail =
    error instanceof Error
      ? (error.stack ?? error.message)
      : typeof error === "string" && error.length > 0
        ? error
        : "the embedded-postgres driver failed without a message";
  console.error(`\npostgres ${command} failed: ${detail}\n`);

  if (command === "start") {
    console.error("most likely causes:");
    console.error(`  • something else is on port ${PG.port} — check with: lsof -ti:${PG.port}`);
    console.error("  • a previous run left a server up — try: pnpm pg:stop");
    console.error(`  • the data directory is damaged — last resort: pnpm pg:reset`);
    if (await alreadyRunning()) {
      console.error(
        `\nnote: something IS answering on ${PG.port} right now, so a server is` +
          " already up and you can just carry on with `pnpm db:setup && pnpm dev`.",
      );
    }
  }
  process.exit(1);
});
