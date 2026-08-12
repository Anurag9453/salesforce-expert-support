/**
 * End-to-end walkthrough of the interest-pool dispatch flow.
 *
 *   DISPATCH_MODE=interest_pool INTEREST_WINDOW_SECONDS=20 pnpm dev
 *   node scripts/e2e-interest-pool.mjs
 *
 * Takes about three minutes, most of it spent waiting out a real two-minute
 * confirmation window rather than mocking the clock.
 *
 * Drives the interest-pool flow end to end against the running dev server,
 * through the same HTTP endpoints the browser uses. No seeded accounts: every
 * actor here is created through the real sign-up and approval path.
 */
const BASE = "http://localhost:3000";
const STAMP = Date.now().toString(36);
const log = (...a) => console.log(...a);
const fail = (msg) => {
  console.error(`\n  ✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
};
const check = (cond, msg) => (cond ? log(`  ✓ ${msg}`) : fail(msg));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client() {
  let cookie = "";
  async function call(method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        // Better Auth rejects same-site-less requests; the browser always sends this.
        origin: BASE,
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) {
      const pair = c.split(";")[0];
      if (pair.startsWith("better-auth")) cookie = pair;
    }
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 200) };
    }
    return { status: res.status, body: json };
  }
  return {
    /** The session cookie, so an SSE reader can open a stream as this actor. */
    cookieHeader: () => cookie,
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b),
    put: (p, b) => call("PUT", p, b),
    patch: (p, b) => call("PATCH", p, b),
    async signUp(email, name) {
      const r = await call("POST", "/api/auth/sign-up/email", {
        email,
        password: "correct-horse-battery-staple",
        name,
      });
      if (r.status !== 200) fail(`sign-up failed for ${email}: ${JSON.stringify(r.body)}`);
      return r.body.user.id;
    },
    email: null,
  };
}

const data = (r) => r.body?.data;

/**
 * Open the SSE stream as this actor and collect real signals.
 *
 * The rest of this script polls, which is exactly what the UI falls back to when
 * realtime is unavailable — so without this, a completely dead push channel
 * would still let every other assertion pass. This is the one check that fails
 * if the doorbell never rings.
 *
 * Frames are parsed properly rather than by scanning for `data:`, because the
 * server sends `event: ready` the instant the stream opens. Treating that as a
 * signal is a false pass: it proves the endpoint is reachable and nothing about
 * whether a broadcast was ever delivered.
 */
function watchStream(actor) {
  const controller = new AbortController();
  const signals = [];
  let ready = false;

  const draining = fetch(`${BASE}/api/v1/realtime`, {
    headers: { cookie: actor.cookieHeader(), origin: BASE, accept: "text/event-stream" },
    signal: controller.signal,
  })
    .then(async (res) => {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const event = /^event:\s*(.+)$/m.exec(frame)?.[1]?.trim();
          const payload = /^data:\s*(.+)$/m.exec(frame)?.[1]?.trim();
          if (event === "ready") ready = true;
          else if (event === "signal" && payload) signals.push(payload);
        }
      }
    })
    .catch(() => {});

  return {
    /** Resolves once the server has confirmed the subscription. */
    async connected(timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (!ready && Date.now() < deadline) await sleep(100);
      return ready;
    },
    async collect(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (signals.length === 0 && Date.now() < deadline) await sleep(200);
      controller.abort();
      await draining;
      return signals;
    },
  };
}

async function makeExpert(label, n) {
  const c = client();
  c.email = `exp-${n}-${STAMP}@local.test`;
  await c.signUp(c.email, label);
  await c.post("/api/v1/expert-application");
  const draft = await c.patch("/api/v1/expert-application", {
    country: "IN",
    timezone: "Asia/Kolkata",
    yearsExperience: 8,
    professionalSummary:
      "Long-standing Salesforce practitioner focused on Apex, Flow and integration work. " +
      "Comfortable with governor limits, bulkification and platform events.",
    languages: ["en"],
    acceptTerms: true,
    acceptConfidentiality: true,
  });
  if (!data(draft)) fail(`draft failed for ${label}: ${JSON.stringify(draft.body)}`);
  const submitted = await c.post("/api/v1/expert-application/submit");
  if (!data(submitted)) fail(`submit failed for ${label}: ${JSON.stringify(submitted.body)}`);
  return c;
}

/**
 * Retire the experts *earlier runs of this script* created.
 *
 * Not housekeeping — without it the walkthrough cannot run. The candidate query
 * takes a bounded pool ordered by least-recently-assigned, and every expert this
 * script has ever created has `lastAssignedAt = null`, so they all tie and the
 * id tiebreak admits the oldest ones forever. After a few runs the new experts
 * sit past the cut and are never considered.
 *
 * Scoped to `exp-<n>-<stamp>@local.test`, which only this script produces, so no
 * account a developer made by hand is touched.
 */
async function retirePreviousRuns() {
  const { default: pg } = await import("pg");
  const here = new URL("../.env", import.meta.url);
  const url = (await import("node:fs")).readFileSync(here, "utf8");
  const match = /^DATABASE_URL=["']?([^"'\n]+)/m.exec(url);
  const client = new pg.Client({ connectionString: match[1] });
  await client.connect();
  const res = await client.query(
    `UPDATE expert_profiles SET status = 'SUSPENDED'
       WHERE status = 'APPROVED'
         AND "userId" IN (SELECT id FROM users WHERE email ~ '^exp-[0-9]+-[a-z0-9]+@local\\.test$')`,
  );
  await client.end();
  return res.rowCount;
}

async function main() {
  log("\n── 0. bench ──");
  if (process.env.RETIRE_OLD_EXPERTS === "1") {
    log(`  retired ${await retirePreviousRuns()} experts left over from earlier runs`);
  } else {
    log("  leaving every earlier expert in place — the pool rotation must cope");
  }

  log("\n── 1. accounts ──");
  const customer = client();
  const customerEmail = `cust-${STAMP}@local.test`;
  await customer.signUp(customerEmail, "E2E Customer");
  log(`  customer ${customerEmail}`);

  const experts = [];
  for (let i = 1; i <= 4; i += 1) experts.push(await makeExpert(`Expert ${i}`, i));
  log(`  ${experts.length} expert applications submitted`);

  const admin = client();
  const adminEmail = `admin-${STAMP}@local.test`;
  await admin.signUp(adminEmail, "E2E Admin");

  const { execFile } = await import("node:child_process");
  await new Promise((resolve, reject) =>
    execFile(
      "pnpm",
      ["grant-role", adminEmail, "ADMIN"],
      { cwd: new URL("..", import.meta.url).pathname },
      (e, stdout) => (e ? reject(new Error(stdout)) : resolve(stdout)),
    ),
  );
  // The role is on the session's user row; re-authenticate so the cookie carries it.
  await admin.post("/api/auth/sign-in/email", {
    email: adminEmail,
    password: "correct-horse-battery-staple",
  });
  // Each expert's own profile id, straight from their session — more reliable
  // than matching names in the admin queue, which other runs also populate.
  for (const e of experts) {
    const me = data(await e.get("/api/v1/me"));
    e.profileId = me?.expert?.profileId;
    if (!e.profileId) fail(`no expert profile on session: ${JSON.stringify(me)}`);
  }
  const queue = await admin.get("/api/v1/admin/experts?status=SUBMITTED");
  const ids = new Set((data(queue)?.items ?? []).map((a) => a.id));
  check(
    experts.every((e) => ids.has(e.profileId)),
    `all 4 new applications are in the admin queue (${data(queue)?.items?.length ?? 0} pending total)`,
  );

  log("\n── 2. approval, skills, availability ──");
  /*
    A sharing-and-permissions scenario, not an Apex one. Every synthetic expert
    left behind by other suites declared Apex-family skills, and the candidate
    query admits anyone holding *any* required skill — so an Apex request puts
    this run's experts behind a hundred strangers in a bounded pool. Picking a
    skill family nobody else has declared isolates the bench without touching a
    single account that someone else might be using.
  */
  const SKILLS = ["sharing", "permission-sets", "profiles", "security"];
  for (const e of experts) {
    const r = await admin.post(`/api/v1/admin/experts/${e.profileId}/decision`, {
      decision: "approve",
      notes: "E2E interest-pool walkthrough.",
    });
    if (!data(r)) fail(`approve failed: ${JSON.stringify(r.body)}`);
  }
  check(true, "all four approved");

  for (const e of experts) {
    for (const skillSlug of SKILLS) {
      const s = await e.put("/api/v1/expert/skills", {
        skillSlug,
        proficiencyLevel: "EXPERT",
        yearsExperience: 7,
      });
      if (!data(s)) fail(`skill declare failed: ${JSON.stringify(s.body)}`);
    }
    const a = await e.put("/api/v1/expert/availability", { available: true });
    if (!data(a)) fail(`availability failed: ${JSON.stringify(a.body)}`);
  }
  check(true, `all four declared ${SKILLS.join(", ")} and went available`);

  log("\n── 3. customer creates a request ──");
  const tax = await customer.get("/api/v1/taxonomy");
  const tiers = data(tax)?.tiers ?? [];
  const tier = tiers.find((t) => t.durationMinutes === 30) ?? tiers[0];
  if (!tier) fail(`no pricing tiers: ${JSON.stringify(tax.body).slice(0, 300)}`);

  // Opened *before* the request exists, so the broadcast cannot beat the
  // subscription. A watcher started afterwards can miss the signal and report a
  // dead push channel that is actually fine.
  const watcher = watchStream(experts[0]);
  await watcher.connected();

  const created = await customer.post("/api/v1/requests", {
    description:
      "Our sharing rules are not behaving after a permission set change. Sales reps " +
      "can suddenly see Opportunity records owned by other regions, and one profile " +
      "lost read access to Accounts entirely. We need help auditing the sharing model, " +
      "the permission set assignments and the profile settings before quarter end.",
    skillSlugs: SKILLS,
    pricingTierId: tier.id,
  });
  const request = data(created)?.request;
  if (!request) fail(`request create failed: ${JSON.stringify(created.body)}`);
  log(`  request ${request.id} — state ${request.state}`);

  log("\n── 3b. the doorbell actually rings ──");
  /*
    Only meaningful when the production provider is wired:

      REALTIME_PROVIDER=postgres DISPATCH_MODE=interest_pool pnpm dev

    Under `mock` the bus deliberately delivers nothing — every offer is still
    created and still visible, which is the point of requirement 10 — so this
    reports a skip rather than failing and implying a broken push channel.
  */
  const signals = await watcher.collect(30_000);
  if (signals.length > 0) {
    check(true, `the broadcast reached the expert's stream (${signals[0]})`);
    check(
      signals.every((line) => Object.keys(JSON.parse(line)).join() === "type"),
      "the payload is a doorbell — a type and nothing else",
    );
  } else {
    log("  ⚠ no realtime signal — REALTIME_PROVIDER is not `postgres`; polling only");
  }

  log("\n── 4. broadcast reaches the experts ──");
  let reached = [];
  for (let i = 0; i < 20 && reached.length < 4; i += 1) {
    await sleep(500);
    reached = [];
    for (const e of experts) {
      const r = await e.get("/api/v1/expert/interest");
      const items = data(r)?.items ?? [];
      if (items.some((o) => o.supportRequestId === request.id)) reached.push(e);
    }
  }
  check(reached.length === 4, `all 4 experts see the opportunity (${reached.length})`);

  const opportunityFor = async (e) => {
    const r = await e.get("/api/v1/expert/interest");
    return (data(r)?.items ?? []).find((o) => o.supportRequestId === request.id);
  };
  const first = await opportunityFor(experts[0]);
  check(
    first && first.description && !("rank" in first) && !("finalScore" in first),
    "opportunity payload carries no rank or score",
  );

  log("\n── 5. responses ──");
  for (const i of [0, 1, 2]) {
    const o = await opportunityFor(experts[i]);
    const r = await experts[i].post(`/api/v1/expert/interest?attemptId=${o.attemptId}`, {
      interested: true,
    });
    if (!data(r)) fail(`interest failed: ${JSON.stringify(r.body)}`);
  }
  const o4 = await opportunityFor(experts[3]);
  await experts[3].post(`/api/v1/expert/interest?attemptId=${o4.attemptId}`, { interested: false });
  check(true, "experts 1–3 interested, expert 4 not interested");

  const gone = await opportunityFor(experts[0]);
  check(!gone, "an answered opportunity disappears from the expert's list");

  log("\n── 6. window closes, shortlist appears ──");
  let shortlist = null;
  for (let i = 0; i < 60; i += 1) {
    await sleep(1000);
    const r = await customer.get(`/api/v1/requests/${request.id}/shortlist`);
    const view = data(r);
    if (view?.candidates?.length) {
      shortlist = view;
      break;
    }
  }
  if (!shortlist) fail("the shortlist never appeared");
  check(shortlist.candidates.length === 3, `exactly 3 candidate cards (${shortlist.candidates.length})`);
  const leaked = Object.keys(shortlist.candidates[0]).filter((k) =>
    ["rank", "score", "finalScore", "expertProfileId", "userId", "email"].includes(k),
  );
  check(leaked.length === 0, `cards leak no rank/score/identity keys (${leaked.join(",") || "none"})`);

  log("\n── 7. customer selects, expert must confirm ──");
  const pickedCard = shortlist.candidates[0];
  const sel = await customer.post(`/api/v1/requests/${request.id}/shortlist`, {
    attemptId: pickedCard.attemptId,
  });
  if (!data(sel)) fail(`selection failed: ${JSON.stringify(sel.body)}`);

  // Whoever now has a CONFIRMING attempt is the chosen expert.
  let chosen = null;
  let offer = null;
  for (const e of experts) {
    const r = await e.get("/api/v1/expert/offer");
    if (data(r)?.attemptId === pickedCard.attemptId) {
      chosen = e;
      offer = data(r);
    }
  }
  if (!chosen) fail("no expert was shown a confirmation");
  check(offer.isConfirmation === true, "the chosen expert sees it as a confirmation, not an offer");
  check(
    offer.secondsRemaining > 100 && offer.secondsRemaining <= 120,
    `confirmation window is ~120s (${offer.secondsRemaining}s)`,
  );

  const other = experts.find((e) => e !== chosen && shortlistHas(shortlist, e));
  const otherOffer = other ? data(await other.get("/api/v1/expert/offer")) : null;
  check(!otherOffer, "no second expert is asked to confirm at the same time");

  const dup = await customer.post(`/api/v1/requests/${request.id}/shortlist`, {
    attemptId: shortlist.candidates[1].attemptId,
  });
  check(dup.body.ok === false, `a second concurrent selection is refused (${dup.body.error?.code})`);

  log("\n── 8. the chosen expert declines; the customer falls back ──");
  const declined = await chosen.post("/api/v1/expert/offer", {
    decision: "decline",
    reason: "NOT_MY_EXPERTISE",
  });
  if (!declined.body.ok) fail(`decline failed: ${JSON.stringify(declined.body)}`);

  let afterDecline = null;
  for (let i = 0; i < 20; i += 1) {
    await sleep(500);
    const r = await customer.get(`/api/v1/requests/${request.id}/shortlist`);
    const view = data(r);
    if (view && !view.awaitingConfirmation && view.candidates.length === 2) {
      afterDecline = view;
      break;
    }
  }
  if (!afterDecline) fail("the customer was left on a dead countdown after a decline");
  check(afterDecline.candidates.length === 2, "the customer is back to the 2 remaining candidates");

  log("\n── 9. second choice confirms ──");
  const second = afterDecline.candidates[0];
  const sel2 = await customer.post(`/api/v1/requests/${request.id}/shortlist`, {
    attemptId: second.attemptId,
  });
  if (!data(sel2)) fail(`second selection failed: ${JSON.stringify(sel2.body)}`);

  let confirmer = null;
  for (const e of experts) {
    const r = await e.get("/api/v1/expert/offer");
    if (data(r)?.attemptId === second.attemptId) confirmer = e;
  }
  if (!confirmer) fail("the second choice was never asked");

  const accepted = await confirmer.post("/api/v1/expert/offer", { decision: "accept" });
  check(accepted.body.ok === true, "the expert confirms");

  const final = await customer.get(`/api/v1/requests/${request.id}`);
  const state = data(final)?.state;
  check(state === "ACCEPTED", `the request reaches ACCEPTED (${state})`);

  log("\n── 10. authorization boundaries ──");
  const stranger = client();
  await stranger.signUp(`nosy-${STAMP}@local.test`, "Stranger");
  const peek = await stranger.get(`/api/v1/requests/${request.id}/shortlist`);
  check(peek.body.ok === false, `another customer cannot read the shortlist (${peek.status})`);

  const steal = await stranger.post(`/api/v1/requests/${request.id}/shortlist`, {
    attemptId: second.attemptId,
  });
  check(steal.body.ok === false, `another customer cannot select (${steal.status})`);

  const notExpert = await stranger.get("/api/v1/expert/interest");
  check(notExpert.body.ok === false, `a non-expert cannot list opportunities (${notExpert.status})`);

  const crossAnswer = await experts[3].post(
    `/api/v1/expert/interest?attemptId=${pickedCard.attemptId}`,
    { interested: true },
  );
  check(
    crossAnswer.body.ok === false || crossAnswer.body.data?.changed === false,
    "an expert cannot answer another expert's attempt",
  );

  log("\n── 11. a confirmation that genuinely times out ──");
  /*
    Section 8 proved the fallback via an explicit decline, which settles
    instantly. That leaves the actual two-minute timer untested — and the timer
    is the part a lost job or a mis-stored deadline would break, with a customer
    watching a countdown that never resolves. So this one waits it out.
  */
  // A second customer: one request in progress per account is enforced, and the
  // first customer's is now ACCEPTED but still live.
  const customer2 = client();
  await customer2.signUp(`cust2-${STAMP}@local.test`, "E2E Customer Two");
  const created2 = await customer2.post("/api/v1/requests", {
    description:
      "A second sharing problem: after last night's permission set changes, our " +
      "support agents cannot see Cases owned by the escalations queue, and one " +
      "profile appears to have lost object-level read on Contacts entirely.",
    skillSlugs: SKILLS,
    pricingTierId: tier.id,
  });
  const request2 = data(created2)?.request;
  if (!request2) fail(`second request failed: ${JSON.stringify(created2.body)}`);

  let raised = 0;
  for (let i = 0; i < 40 && raised < 2; i += 1) {
    await sleep(500);
    raised = 0;
    for (const e of experts) {
      const r = await e.get("/api/v1/expert/interest");
      const o = (data(r)?.items ?? []).find((x) => x.supportRequestId === request2.id);
      if (o) {
        await e.post(`/api/v1/expert/interest?attemptId=${o.attemptId}`, { interested: true });
        raised += 1;
      }
    }
  }
  check(raised >= 2, `at least 2 experts raised a hand on the second request (${raised})`);

  let list2 = null;
  for (let i = 0; i < 60 && !list2; i += 1) {
    await sleep(1000);
    const view = data(await customer2.get(`/api/v1/requests/${request2.id}/shortlist`));
    if (view?.candidates?.length >= 2) list2 = view;
  }
  if (!list2) fail("the second shortlist never appeared");

  const doomed = list2.candidates[0];
  const sel3 = await customer2.post(`/api/v1/requests/${request2.id}/shortlist`, {
    attemptId: doomed.attemptId,
  });
  if (!data(sel3)) fail(`third selection failed: ${JSON.stringify(sel3.body)}`);
  const waiting = data(await customer2.get(`/api/v1/requests/${request2.id}/shortlist`));
  check(!!waiting.awaitingConfirmation, "the customer sees a live countdown");

  log("  waiting out the full 120s window (nobody answers)…");
  let recovered = null;
  for (let i = 0; i < 150 && !recovered; i += 1) {
    await sleep(1000);
    const view = data(await customer2.get(`/api/v1/requests/${request2.id}/shortlist`));
    if (view && !view.awaitingConfirmation) recovered = view;
  }
  if (!recovered) fail("the confirmation never lapsed — the customer is stuck on a dead countdown");
  check(true, "the window lapsed on its own");
  check(
    !recovered.candidates.some((c) => c.attemptId === doomed.attemptId),
    "the expert who went silent is off the shortlist",
  );
  check(recovered.candidates.length >= 1, `the remaining candidates are offered (${recovered.candidates.length})`);

  log("\nall checks passed\n");
}

function shortlistHas(shortlist, expert) {
  return shortlist.candidates.some((c) => c.attemptId && expert.profileId);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
