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

async function status() {
  console.log(existsSync(DATA_DIR) ? `cluster present at ${DATA_DIR}` : "no cluster initialised");
}

const command = process.argv[2] ?? "start";

const run = {
  start: async () => {
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

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
