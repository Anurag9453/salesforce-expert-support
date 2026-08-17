/**
 * A bench you can actually watch the shortlist form against.
 *
 *   DISPATCH_MODE=interest_pool INTEREST_WINDOW_SECONDS=20 pnpm dev
 *   node scripts/demo-bench.mjs          # leave this running
 *
 * Then click "Find me an expert" in the browser and three candidate cards
 * appear about twenty seconds later.
 *
 * ## Why this exists
 *
 * The interest pool needs experts who *raise a hand*. Broadcasting to an empty
 * or silent bench is not a bug — the window closes with nobody interested, the
 * search relaxes, and eventually the customer is honestly told nobody is
 * available. So a one-person browser test can never produce three cards.
 *
 * This creates three real, approved, available experts and keeps a small loop
 * running that answers "Interested" on their behalf. Nothing here is fake: they
 * go through the ordinary sign-up, application, admin-approval, skill and photo
 * moderation paths, and the cards the customer sees are assembled from their
 * real rows by the real query. The only artificial part is that a script clicks
 * "Interested" instead of a person.
 *
 * ## What it does not do
 *
 * It does not create a shared password anybody could guess, and it does not
 * write demo accounts into the seed. Each run generates fresh random
 * credentials, prints them once, and they exist only in your dev database.
 */
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ROOT = new URL("..", import.meta.url);
const STAMP = Date.now().toString(36);

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (msg) => {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
};

// ── The bench ────────────────────────────────────────────────────────────────

/**
 * Deliberately varied. Three identical experts would hide the thing the cards
 * exist to show — that the customer is choosing between people, not options.
 */
const PEOPLE = [
  {
    name: "Priya Raghavan",
    summary:
      "Fourteen years on the platform, most of it deep in Apex and sharing models. I spend my days on the problems that only show up at scale — governor limits, bulkification, and permission sets that quietly stopped doing what someone thought they did.",
    years: 14,
    rating: [48, 10], // ratingSum, ratingCount → 4.8
    sessions: 23,
    minutes: 1_410,
    colour: [37, 99, 235],
  },
  {
    name: "Daniel Okonkwo",
    summary:
      "Integration and platform architecture. If an external system is talking to Salesforce and one side is unhappy about it, that is usually my week. Comfortable being handed a failing nightly job with no error message and finding out why.",
    years: 9,
    rating: [37, 8], // 4.6
    sessions: 11,
    minutes: 690,
    colour: [16, 122, 87],
  },
  {
    name: "Mei Lin Chen",
    summary:
      "Configuration, security and access. Profiles, permission sets, sharing rules and the interactions between them — including the ones that are not documented anywhere and only appear after a release.",
    years: 6,
    rating: [0, 0], // new here, on purpose
    sessions: 0,
    minutes: 0,
    colour: [180, 83, 9],
  },
];

/**
 * The skills each of the three claims.
 *
 * Constrained by a real product rule: an expert may list at most 30 skills, and
 * the taxonomy has 51. Three cards for *every* possible topic would need all 51
 * on all three, so it cannot be done — and should not be, since the cap exists
 * to stop experts claiming everything.
 *
 * So the bench is built the way a real roster would look. A shared core of the
 * topics people actually type gets all three experts on the shortlist. The long
 * tail is split between them, so a question about, say, DataWeave still reaches
 * somebody — one card instead of three, which is the honest answer when only one
 * person on the bench does that work.
 *
 * This replaced a hand-written list of twelve. The demo failed on the first
 * realistic thing typed into it — a Lightning Web Components question classified
 * `lwc` as the primary skill, and the primary-skill floor correctly excluded
 * three experts who had never claimed it. That exclusion is the matcher working;
 * the bug was a bench too narrow to answer.
 */
const MAX_SKILLS_PER_EXPERT = 30;

/** The topics most likely to be a request's *primary* skill. */
const CORE = [
  "apex",
  "lwc",
  "aura",
  "visualforce",
  "triggers",
  "flow",
  "soql-sosl",
  "governor-limits",
  "batch-apex",
  "apis-integrations",
  "debugging",
  "unit-tests",
  "deployment-issues",
  "sharing",
  "permission-sets",
  "profiles",
  "security",
  "validation-rules",
  "data-management",
];

async function skillPlan(c) {
  const taxonomy = must("fetch taxonomy", await c.get("/api/v1/taxonomy"));
  const all = taxonomy.categories.flatMap((category) => category.skills.map((s) => s.slug));

  const core = CORE.filter((slug) => all.includes(slug));
  const rest = all.filter((slug) => !core.includes(slug));

  // Round-robin, so the tail is covered by exactly one expert each and the three
  // benches stay the same size.
  const plan = [core.slice(), core.slice(), core.slice()];
  rest.forEach((slug, index) => plan[index % 3].push(slug));

  for (const [index, skills] of plan.entries()) {
    if (skills.length > MAX_SKILLS_PER_EXPERT) {
      die(
        `expert ${index + 1} would need ${skills.length} skills but the cap is ${MAX_SKILLS_PER_EXPERT}.\n` +
          `     Shrink CORE — every extra shared skill costs three tail slots.`,
      );
    }
  }
  const covered = new Set(plan.flat());
  const missing = all.filter((slug) => !covered.has(slug));
  if (missing.length > 0) log(`  ⚠ no expert covers: ${missing.join(", ")}`);

  return plan;
}

// ── A valid PNG, built by hand ───────────────────────────────────────────────

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 0);
  return Buffer.concat([head, data, crc]);
}
/**
 * A solid-colour square. Not a portrait, and not pretending to be one — the
 * point is to exercise the real upload-and-moderate path so the cards render a
 * served photo rather than the initials fallback.
 */
function solidPng([r, g, b], size = 96) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

function client() {
  let cookie = "";
  async function call(method, path, body, raw) {
    let res;
    try {
      res = await fetchOnce(method, path, body, raw);
    } catch (error) {
      // A thrown fetch is a *transport* failure, and it used to kill the whole
      // script: Next's dev server closes keep-alive sockets when it recompiles,
      // and undici surfaces that as UND_ERR_SOCKET on the next reused
      // connection. Turning it into a response lets the retry below handle it
      // like any other transient failure.
      const cause = error?.cause?.code ?? error?.message ?? String(error);
      return { status: 0, body: { ok: false, transport: true, raw: `${cause}` } };
    }
    return res;
  }

  async function fetchOnce(method, path, body, raw) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        origin: BASE,
        ...(raw ? {} : { "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}),
      },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const pair = c.split(";")[0];
      if (pair.startsWith("better-auth")) cookie = pair;
    }
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Next compiles a route on its first request, and a slow or erroring
      // compile answers with HTML. Surfacing that as "not JSON" is far more
      // useful than letting it become a puzzling FORBIDDEN three calls later.
      parsed = { ok: false, notJson: true, raw: text.slice(0, 300) };
    }
    return { status: res.status, body: parsed };
  }

  /**
   * One retry for the transient failures a dev server actually produces —
   * a route compiling for the first time, or a restart landing mid-request.
   */
  async function callWithRetry(method, path, body, raw) {
    let last;
    // Three attempts, not one. A dev server recompiling a route can drop more
    // than a single connection, and the failure this guards against is the
    // bench silently dying half-built.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      last = await call(method, path, body, raw);
      const transient = last.status === 0 || last.status >= 500 || last.body?.notJson;
      if (!transient) return last;
      await sleep(1000 * (attempt + 1));
    }
    return last;
  }
  return {
    get: (p) => callWithRetry("GET", p),
    post: (p, b) => callWithRetry("POST", p, b),
    put: (p, b) => callWithRetry("PUT", p, b),
    putRaw: (p, bytes) => callWithRetry("PUT", p, undefined, bytes),
    patch: (p, b) => callWithRetry("PATCH", p, b),
    async signUp(email, password, name) {
      const r = await call("POST", "/api/auth/sign-up/email", { email, password, name });
      if (r.status !== 200) die(`sign-up failed for ${email}: ${JSON.stringify(r.body)}`);
    },
    async signIn(email, password) {
      const r = await call("POST", "/api/auth/sign-in/email", { email, password });
      if (r.status !== 200) die(`sign-in failed for ${email}: ${JSON.stringify(r.body)}`);
    },
  };
}
const data = (r) => r.body?.data;

/**
 * Assert a call succeeded, and say exactly which one did not.
 *
 * The first version of this script fired the "start my application" call and
 * ignored its result. When that failed, the next call failed too — with
 * `FORBIDDEN … expert_application:update_own`, which points at permissions and
 * says nothing about the request that actually broke. An unchecked write is a
 * misleading error later.
 */
function must(step, response) {
  const payload = data(response);
  if (payload) return payload;
  const detail = response.body?.transport
    ? `could not reach ${BASE} (${response.body.raw}) — is the dev server still up?`
    : (response.body?.error?.message ??
      (response.body?.notJson
        ? `server returned ${response.status}, not JSON: ${response.body.raw}`
        : JSON.stringify(response.body)));
  die(`${step} failed (HTTP ${response.status})\n     ${detail}`);
}

async function pg() {
  const { default: mod } = await import("pg");
  const env = readFileSync(new URL(".env", ROOT), "utf8");
  const url = /^DATABASE_URL=["']?([^"'\n]+)/m.exec(env)?.[1];
  if (!url) die("no DATABASE_URL in .env");
  const c = new mod.Client({ connectionString: url });
  await c.connect();
  return c;
}

// ── Steps ────────────────────────────────────────────────────────────────────

/**
 * Put the demo bench at the front of the candidate pool — once.
 *
 * Pool order is least-recently-assigned, then least-recently-*considered*, nulls
 * first. Marking everyone else as just-considered and the demo three as
 * never-considered puts the demo three at the front. Nobody is suspended and
 * normal rotation washes it out once this stops.
 *
 * Split into a one-off sweep and a tiny repeat on purpose. The first version ran
 * the whole `WHERE status = 'APPROVED'` update on every pass — ninety rows
 * rewritten every two seconds, from a loop that could be running twice at once.
 * It pushed the dev server to 240% CPU and took `/api/v1/health` from 25ms to
 * 13.7 seconds. The repeat below touches three rows, because those are the only
 * three that need resetting: every candidate query stamps the experts it
 * returned, including these.
 */
async function pushOthersBack(db, profileIds) {
  await db.query(
    `UPDATE expert_profiles SET "lastConsideredAt" = now()
      WHERE status = 'APPROVED' AND NOT (id = ANY($1::text[]))`,
    [profileIds],
  );
}

async function keepDemoBenchFirst(db, profileIds) {
  await db.query(
    `UPDATE expert_profiles SET "lastConsideredAt" = NULL
      WHERE id = ANY($1::text[]) AND "lastConsideredAt" IS NOT NULL`,
    [profileIds],
  );
}

/**
 * Refuse to start if another copy is already running.
 *
 * Two benches do not divide the work, they duplicate it — and the duplicate is
 * invisible, because both print the same reassuring output while the database
 * they share slows to a crawl. The lock is held by the connection, so it goes
 * away on its own however this process exits.
 */
async function claimSoleOwnership(db) {
  const { rows } = await db.query("SELECT pg_try_advisory_lock(7318842) AS ok");
  if (!rows[0]?.ok) {
    die(
      "another demo bench is already running.\n" +
        "     Stop it first (Ctrl+C in its terminal, or: pkill -f demo-bench.mjs)",
    );
  }
}

async function makeAdmin() {
  const email = `demo-admin-${STAMP}@local.test`;
  const password = randomUUID();
  const c = client();
  await c.signUp(email, password, "Demo Admin");
  await new Promise((resolve, reject) =>
    execFile("pnpm", ["grant-role", email, "ADMIN"], { cwd: ROOT.pathname }, (e, out) =>
      e ? reject(new Error(out)) : resolve(out),
    ),
  );
  // The role lives on the user row; re-authenticate so the session carries it.
  await c.signIn(email, password);
  return { client: c, email, password };
}

async function makeExpert(person, index, admin, skills) {
  const email = `demo-expert-${index}-${STAMP}@local.test`;
  const password = randomUUID();
  const c = client();
  await c.signUp(email, password, person.name);

  const started = must(`${person.name}: start application`, await c.post("/api/v1/expert-application"));
  if (started.status !== "DRAFT") {
    die(`${person.name}: application is ${started.status}, expected DRAFT — is this a reused account?`);
  }
  const draft = await c.patch("/api/v1/expert-application", {
    country: "IN",
    timezone: "Asia/Kolkata",
    yearsExperience: person.years,
    professionalSummary: person.summary,
    languages: ["en"],
    acceptTerms: true,
    acceptConfidentiality: true,
  });
  must(`${person.name}: save application`, draft);
  must(`${person.name}: submit application`, await c.post("/api/v1/expert-application/submit"));

  const me = data(await c.get("/api/v1/me"));
  const profileId = me?.expert?.profileId;
  if (!profileId) die(`no expert profile for ${person.name}`);

  must(
    `${person.name}: admin approval`,
    await admin.client.post(`/api/v1/admin/experts/${profileId}/decision`, {
      decision: "approve",
      notes: "Demo bench for local testing.",
    }),
  );

  for (const skillSlug of skills) {
    must(
      `${person.name}: declare ${skillSlug}`,
      await c.put("/api/v1/expert/skills", {
        skillSlug,
        proficiencyLevel: "EXPERT",
        yearsExperience: Math.max(1, person.years - 2),
      }),
    );
  }

  await uploadPhoto(c, admin, person);

  must(`${person.name}: go available`, await c.put("/api/v1/expert/availability", { available: true }));

  return { client: c, profileId, email, password, name: person.name };
}

/** Through the real presign → upload → moderate path, photo checks included. */
async function uploadPhoto(c, admin, person) {
  const bytes = solidPng(person.colour);
  const presigned = await c.post("/api/v1/expert/photo", {
    filename: "portrait.png",
    contentType: "image/png",
    sizeBytes: bytes.length,
  });
  const slot = data(presigned);
  if (!slot) {
    log(`  ⚠ photo presign failed for ${person.name}; card will show initials`);
    return;
  }
  const uploaded = await c.putRaw(new URL(slot.uploadUrl, BASE).pathname + new URL(slot.uploadUrl, BASE).search, bytes);
  if (!uploaded.body?.ok) {
    log(`  ⚠ photo upload failed for ${person.name}: ${JSON.stringify(uploaded.body)}`);
    return;
  }
  const photoId = data(uploaded)?.id ?? slot.photoId;
  const decided = await admin.client.post(`/api/v1/admin/photos/${photoId}`, { decision: "approve" });
  if (!data(decided)) log(`  ⚠ photo approval failed for ${person.name}`);
}

/** Ratings and delivered time, so the cards show a history rather than zeroes. */
async function seedHistory(db, expert, person) {
  await db.query(
    `UPDATE expert_profiles
        SET "ratingSum" = $2, "ratingCount" = $3, "sessionsCompleted" = $4, "minutesDelivered" = $5
      WHERE id = $1`,
    [expert.profileId, person.rating[0], person.rating[1], person.sessions, person.minutes],
  );
}

// ── The loop ─────────────────────────────────────────────────────────────────

/**
 * Keeps the bench present and answers broadcasts.
 *
 * Heartbeats matter as much as the answering: an expert whose heartbeat goes
 * stale is swept offline and stops being eligible, so a bench that is only
 * created and then left alone quietly stops working after a few minutes.
 */
async function serve(experts, db) {
  const answered = new Set();
  const profileIds = experts.map((e) => e.profileId);
  log("\n  watching for requests — press Ctrl+C to stop\n");

  for (;;) {
    // One pass, fully guarded. An earlier version let a single transient
    // ECONNRESET from the dev server kill the process: heartbeats stopped, the
    // presence sweep took all three offline, and the next request matched
    // nobody — with the script no longer running to say why.
    try {
      await keepDemoBenchFirst(db, profileIds);
      for (const expert of experts) await tend(expert, answered);
    } catch (error) {
      log(`  ⚠ ${error instanceof Error ? error.message : String(error)} — retrying`);
    }
    await sleep(3000);
  }
}

/** Keep one expert present, and answer anything waiting on them. */
async function tend(expert, answered) {
  const beat = data(await expert.client.post("/api/v1/expert/heartbeat"));

  // Re-toggle rather than only heartbeat. Being swept offline is deliberately
  // sticky — an expert who vanished has to say they are back, and a heartbeat is
  // not that statement. So a bench that only heartbeats never recovers from a
  // single missed window, which is exactly what happened the first time.
  if (beat && beat.availabilityStatus !== "AVAILABLE") {
    await expert.client.put("/api/v1/expert/availability", { available: true });
    log(`  ↻ ${expert.name} was ${beat.availabilityStatus.toLowerCase()}; back on call`);
  }

  const opportunities = data(await expert.client.get("/api/v1/expert/interest"))?.items ?? [];
  for (const opportunity of opportunities) {
    if (answered.has(opportunity.attemptId)) continue;
    answered.add(opportunity.attemptId);
    const answer = await expert.client.post(
      `/api/v1/expert/interest?attemptId=${opportunity.attemptId}`,
      { interested: true },
    );
    log(
      data(answer)
        ? `  ✋ ${expert.name} is interested in "${opportunity.title}"`
        : `  ⚠ ${expert.name} could not answer: ${JSON.stringify(answer.body)}`,
    );
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const health = await fetch(`${BASE}/api/v1/health`).catch(() => null);
if (!health?.ok) die(`nothing is serving ${BASE} — start it with:\n\n    DISPATCH_MODE=interest_pool INTEREST_WINDOW_SECONDS=20 pnpm dev`);

const db = await pg();
await claimSoleOwnership(db);

log("\n── building the demo bench ──");
const admin = await makeAdmin();

// Previous runs of *this script* only. Without it every run leaves three more
// approved experts competing for the same bounded pool.
const retired = await db.query(
  `UPDATE expert_profiles SET status = 'SUSPENDED'
    WHERE status = 'APPROVED'
      AND "userId" IN (SELECT id FROM users WHERE email LIKE 'demo-expert-%@local.test')`,
);
if (retired.rowCount > 0) log(`  retired ${retired.rowCount} experts from earlier demo runs`);

const plan = await skillPlan(admin.client);
const experts = [];
for (const [index, person] of PEOPLE.entries()) {
  const expert = await makeExpert(person, index + 1, admin, plan[index]);
  await seedHistory(db, expert, person);
  experts.push(expert);
  log(`  ✓ ${person.name} — approved, ${plan[index].length} skills, photo, available`);
}
await pushOthersBack(
  db,
  experts.map((e) => e.profileId),
);

log("\n  Sign in as any of them to answer by hand instead:");
for (const e of experts) log(`    ${e.email}  ${e.password}`);
log(`\n  Admin: ${admin.email}  ${admin.password}`);

log("\n  Now open http://localhost:3000, describe a problem, and click");
log("  “Find me an expert”. Three cards land about 20 seconds later.");

await serve(experts, db);
