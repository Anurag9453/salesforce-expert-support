# Running it locally

Verified working on this machine as of Phase 5.

---

## First time

```bash
pnpm install
```

`.env` already exists with a generated `BETTER_AUTH_SECRET`. If you ever need a fresh one:
`cp .env.example .env` then put `openssl rand -base64 32` into `BETTER_AUTH_SECRET`.

---

## Every time — two terminals

**Terminal 1 — database.** Leave it running; <kbd>ctrl</kbd>+<kbd>c</kbd> stops it.

```bash
pnpm pg:start
```

No Docker and no Homebrew service: this runs a Postgres binary from inside the project on port
**55432**, with its data in `.pgdata/` (gitignored). First run downloads the binary.

**Terminal 2 — migrate, seed, and start.**

```bash
pnpm db:setup   # applies migrations + seeds the taxonomy. Safe to re-run.
pnpm dev        # starts the web app and the worker together
```

Then open:

> ## **http://localhost:3000**

`pnpm dev` runs both apps. Web is on **3000**; the worker has no HTTP surface — it boots, registers
its six queues, classifies incoming requests, runs the dispatch loop (offer → 60s → next expert →
15-minute deadline), and sweeps stale presence.

**Health check:** http://localhost:3000/api/v1/health should return
`{"status":"ok", ... "payment=mock payout=mock"}`.

---

## Testing the three experiences

**There are no seeded demo accounts, deliberately.** Shipping fixed demo credentials is how a
throwaway password ends up live in production. You create accounts through the real sign-up flow;
the only privileged step happens out of band, at the command line.

### 1. Customer

1. Open http://localhost:3000/register
2. Any email (it is never sent to), any name, **password of at least 12 characters**
3. You land on `/dashboard`

What to look at: role badge shows `customer` only. "Get Expert Help" opens the request form. The
right-hand card offers "Become an Expert" on this same account.

### 2. Expert applicant → approved expert

Use the **same account** as step 1 — that is the point. One account holds both roles; becoming an
expert is not a second signup.

1. From the dashboard, click **Become an Expert** (or go to `/expert-application`)
2. Click **Start my application** → status becomes `Draft`, and your roles become `customer expert`
3. Fill in the form. Required: country, time zone, years of experience, professional summary, and
   both checkboxes. **Save draft** first — the Submit button stays disabled until nothing is
   outstanding, and it tells you what is missing.
4. Click **Submit for review** → status `Submitted`, and the form locks

What to look at: at every point before approval the dashboard says **"not yet eligible for
matching"**. Try `/expert` in the address bar — it redirects you back, because holding the EXPERT
role is not the same as being approved.

Then, after step 3 below approves you: revisit `/dashboard` (it will say "eligible for matching")
and `/expert` (the workspace now opens).

### 3. Admin

Admin cannot be self-assigned through any UI — that is a deliberate hole in the product. Register a
second account, then promote it from the command line:

```bash
# 1. Register at http://localhost:3000/register with a second email, e.g. admin@local.test
# 2. Then, in a terminal:
pnpm grant-role admin@local.test ADMIN
```

You should see `admin@local.test → CUSTOMER, ADMIN`. Sign out, sign back in as that account, and an
**Admin** link appears in the header.

1. Go to `/admin/experts` — the queue, oldest submission first
2. Click the application from step 2
3. **Claim for review** (optional), then **Approve** — a written reason is mandatory, and the
   button will not enable without one
4. The **Lifecycle history** panel now shows who did what, when, with the reason

Also worth trying: **Reject** it and then, as the applicant, edit the form — a rejected application
reopens as a draft so it can be resubmitted. And **Suspend** an approved expert, then check the
applicant's `/expert` immediately stops opening.

### 4. Expert availability (Phase 4)

Once approved, `/expert` opens with the availability banner. Two things are worth knowing before you
try to watch the presence sweep:

**The sweep is slow on purpose.** The default window is three minutes, chosen against browser
background-tab throttling. To see it in under a minute, start the dev servers with a short one:

```bash
HEARTBEAT_STALE_AFTER_SECONDS=20 HEARTBEAT_INTERVAL_SECONDS=5 pnpm dev
```

The worker prints `presence sweep scheduled … staleAfterSeconds: 20` at boot. If it prints `180`,
the override did not reach it.

**It sweeps on a 30-second cadence**, so budget the window plus up to 30 seconds. Go available,
close the tab, wait, reopen — you are offline, with an explanation, and you stay offline until you
turn it back on. That is deliberate: nothing puts an expert back in the dispatch pool without them
saying so.

### 5. The matching loop (Phase 5)

This is the core product. You need a customer, **two** approved experts with real skills, and an
admin — the setup is in [PHASE-5.md](PHASE-5.md) under the two-browser walkthrough.

The one thing to know before you try: **an expert with no declared skills can never be matched.**
Approval and availability are not enough; matching is on skills. Add Apex at ADVANCED or better on
`/expert/skills` before expecting an Apex request to reach anyone.

Shorten the offer window to watch a timeout without waiting a minute:

```bash
OFFER_WINDOW_SECONDS=20 pnpm dev
```

Then `/admin/requests` shows everything in flight, and clicking one shows every candidate, every
score, and every exclusion reason — which is how you answer "why that expert and not the other one".

### Fastest full loop

Two browser profiles (or one normal window + one incognito) side by side: applicant in one, admin in
the other. Approve in the admin window, refresh the applicant's dashboard, and watch
"not yet eligible" flip to "eligible".

---

## Handy commands

| Command                         | What it does                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| `pnpm dev`                      | Web + worker                                                                              |
| `pnpm verify`                   | The full phase gate: format, lint, typecheck, tests, fresh migrations, build, worker boot |
| `pnpm verify --quick`           | Static checks only, no database                                                           |
| `pnpm db:studio`                | Prisma Studio — browse the data                                                           |
| `pnpm grant-role <email> ADMIN` | Promote an existing user                                                                  |
| `pnpm e2e:phase2`               | 41 HTTP checks against a running server                                                   |
| `pnpm e2e:phase3`               | 27 HTTP checks — request intake, redaction, classification                                |
| `pnpm e2e:phase4`               | 61 HTTP checks — availability, skills, the live presence sweep                            |
| `pnpm e2e:phase5`               | 64 HTTP checks — matching, the offer loop, manual dispatch                                |
| `pnpm e2e`                      | All four, in order                                                                        |
| `pnpm pg:stop`                  | Stop the database                                                                         |

---

## If something is wrong

**"Can't reach database server"** — Terminal 1 isn't running. `pnpm pg:start`.

**Port 3000 or 55432 already in use** — something from an earlier run survived.
`lsof -ti:3000 | xargs kill` (and `pnpm pg:stop` for the database).

**Blank page or a stale route after I change code** — `rm -rf apps/web/.next` and restart `pnpm dev`.

**`pnpm db:migrate:fresh` asks for consent** — that is intentional. Prisma blocks destructive
database actions when an AI agent is driving it. `pnpm verify` never needs it: it proves migrations
apply cleanly by creating a throwaway database rather than dropping yours.

**Want a genuinely clean slate** — `pnpm pg:reset` then `pnpm db:setup`. This destroys all local data.
