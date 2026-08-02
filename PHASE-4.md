# Phase 4 — Expert Availability · Gate Summary

**Status:** Complete. `pnpm verify` 9/9, `pnpm e2e:phase4` 61/61 (including a real sweep). Stopped
before Phase 5.
**Date:** 2026-08-02
**Checkpoints:** Phase 1 `6abcd51`, Phase 2 `5cb8c4e`, Phase 3 `a80b7d8`. Phase 4 uncommitted,
awaiting approval.

---

## 👀 Requirement 10 — the manual browser walkthrough

This is the one thing I cannot do for you. Everything below has an automated equivalent that passed,
but requirement 10 asks for the sweep observed in a browser, so here is the exact sequence.

### Start with a short presence window

The real window is three minutes. Override it so a sweep takes seconds, not a coffee break:

```bash
# terminal 1
pnpm pg:start

# terminal 2
HEARTBEAT_STALE_AFTER_SECONDS=20 HEARTBEAT_INTERVAL_SECONDS=5 pnpm dev
```

Watch terminal 2 — the worker prints `presence sweep scheduled … staleAfterSeconds: 20` at boot. If
it says `180`, the override did not reach it and the walkthrough below will take four minutes rather
than one.

### Setup — an approved expert (two minutes)

1. Register two accounts at `/register` (12+ character passwords). One is the expert, one the admin.
2. Make the second an admin: `pnpm grant-role <admin-email> ADMIN`
3. As the expert: `/expert-application` → **Apply to become an expert** → fill it in → **Submit**.
4. As the admin: `/admin/experts` → open it → **Claim for review** → **Approve** with a reason.

### The walkthrough

| Step                                                                      | What to look for                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1.** As the expert, open `/expert`                                      | A grey banner: **"You are not receiving requests"**, with **"You are set to offline"** underneath. Approval alone did not put you in the pool — that is requirement 4, visible.                                                                                                            |
| **2.** Click **Go available**                                             | The banner turns green: **"You are receiving requests"** / _"Everything is in order — you are in the pool for matching requests."_ A pulsing dot, an **Online** badge, and a line saying we check in every 5 seconds. This is requirement 6 — judge whether it reads from across the room. |
| **3.** Leave the tab open ~15s                                            | The **Last check-in** figure stays near 0. Open devtools → Network and you will see `POST /api/v1/expert/heartbeat` every 5 seconds.                                                                                                                                                       |
| **4.** **Close the tab** (or stop the ping: devtools → Network → Offline) | Nothing to see yet — this is the expert walking away.                                                                                                                                                                                                                                      |
| **5.** Wait ~50 seconds                                                   | 20s window + up to 30s for the worker's next sweep pass. Terminal 2 logs `expert swept offline for stale presence` and then `heartbeat sweep complete {"swept":1}`.                                                                                                                        |
| **6.** Reopen `/expert`                                                   | **This is the requirement.** Grey banner, **"You are not receiving requests"**, and a warning box: _"We took you offline — we stopped hearing from this page… You will stay offline until you turn availability back on — we never do that for you."_ **Availability was not restored.**   |
| **7.** Reload a few more times, leave it open a minute                    | Still offline. Still offline. The page pings only while online, so nothing is even trying to bring you back — and if it did, `touchHeartbeat` writes a timestamp and cannot write a status.                                                                                                |
| **8.** Check **Availability history** at the bottom of the page           | `AVAILABLE → OFFLINE` · _"We stopped hearing from your browser"_ with a timestamp. A status that changes on its own is only acceptable if you can find out why.                                                                                                                            |
| **9.** Click **Go available**                                             | Green again, immediately, with **Last check-in 0s ago** — the toggle seeds presence so there is no dead window before the first ping.                                                                                                                                                      |

### Also worth clicking

**`/expert/skills`** — requirement 7 is a copy-and-layout problem, so this needs your eye more than
your logic:

- The four proficiency levels read **Learning → Working knowledge → Strong → Deep**, each described
  by observable behaviour ("_You debug the difficult cases and other people ask you about this
  one_") rather than by confidence. **Deep** says _"Pick this sparingly — it is what we match the
  hardest problems on."_ Nothing is preselected. Tell me if that is enough friction, or if it needs
  to cost something more concrete.
- **Years with this skill** — the hint says _"not your total Salesforce experience. Zero is a fine
  answer."_
- Every skill carries a **Self-declared** badge. There is no control anywhere on this page that
  could turn it into **Verified**.
- Add a skill, then have the admin verify it (`/admin/experts/<id>` → **Declared skills** →
  **Verify** + notes). Come back and edit the proficiency: you get warned first — _"This will remove
  the verified badge"_ — and it does.

**`/expert/profile`** — requirement 8. Edit your summary and save; you stay **APPROVED** and are not
sent back for review. Below the form, **"Set by our review team"** lists every administrative field
by name, expanded from the same constant the domain enforces.

### Known rough edges

- The dashboard shows availability, skills and history. Incoming requests and earnings are Phase 5
  and Phase 9 — the card at the bottom says so rather than showing an empty widget.
- Availability history renders raw status names (`AVAILABLE → OFFLINE`). The _cause_ is in plain
  English; the statuses are not. Worth prettifying, low value.
- There is no push when a sweep happens while the tab is closed. Phase 6 owns notifications.

---

## Gate results

```
── verify ──                                  ── e2e (real HTTP) ──
  ✓ format                                2.2s    phase2:  41 passed, 0 failed
  ✓ lint                                  7.3s    phase3:  27 passed, 0 failed
  ✓ typecheck                             6.6s    phase4:  61 passed, 0 failed
  ✓ test                                  5.9s
  ✓ local postgres available              0.1s
  ✓ migrations apply to a fresh database   5.5s
  ✓ dev database is migrated and seeded    4.0s
  ✓ web builds                            18.8s
  ✓ worker boots                           1.8s
```

| Gate requirement | Result                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------- |
| Tests            | **264 passing** (was 171) — 223 domain, 28 contracts, 13 adapters                       |
| Lint             | Clean, 7 packages, 0 errors                                                             |
| TypeScript       | `tsc --noEmit` clean, `strict` + `noUncheckedIndexedAccess`                             |
| Migrations       | **None needed** — the Phase 1 schema already carried every presence and skill column    |
| Build / boot     | Web builds **37 routes**; worker registers 6 queues, runs classify + the presence sweep |

**Exit criterion met:** an APPROVED expert goes AVAILABLE, is matching-eligible, stops pinging, is
swept OFFLINE by the worker, stays OFFLINE across further heartbeats, and returns only by choosing
to — verified over HTTP with real cookies in `phase4-availability.sh`, with the sweep actually
elapsing rather than being simulated.

---

## Your ten requirements, as built

### 1 — A skill claim is (skill, self-rated proficiency, years with that skill)

Three fields, and the third is the one people get wrong. `yearsExperience` on a skill is _years with
that skill_, not years in Salesforce — the profile has its own separate figure. Eight years in
Salesforce and six months of CPQ is a common, honest shape, and flattening it would hide from
matching exactly the thing matching needs.

Zero is accepted. Forcing a minimum of one year would push people to round up.

`expert-skill-service.ts` · tested in `expert-skills.test.ts`

### 2 — Self-declared and verified stay distinct, and experts cannot verify themselves

Enforced **structurally**, not by checking a flag. `ExpertSkillDeclaration` — the type every
expert-facing path takes — has three fields and none of them is `verified`. There is no value a
client could send and no handler that could forward one.

Four barriers, from outermost to the one that actually holds:

1. `declareSkillSchema` has no `verified` key, so it is stripped at the boundary.
2. `ExpertSkillService.declare` takes a declaration type that cannot express it.
3. `setVerified` requires `admin:verify_expert_skill` and mandatory notes, and is audited.
4. The Prisma `declare` upsert writes `verified: false` in both the create and the update branch.

**Re-declaring a verified skill clears the verification.** The claim an admin checked has changed, so
the old check no longer covers it — otherwise re-declaring is a laundering route from unverified to
verified. The expert is warned before they save, and the clearing is written to the audit log.

`e2e: "an expert cannot verify their own skill"`, `"and cannot reach the admin route either"`,
`"re-declaring clears the verification"`

### 3 — Only approved experts may turn themselves AVAILABLE

`canGoAvailable(expertStatus)` is a three-line function so it can be asserted against every status
individually. The availability service calls it against the expert's **application status read from
the database** — not against a role, and not against anything in the request.

All five non-approved statuses are covered by a parameterised domain test. Four of the six are also
exercised over real HTTP:

| Status         | `PUT /api/v1/expert/availability {"available":true}` | Covered over HTTP  |
| -------------- | ---------------------------------------------------- | ------------------ |
| `DRAFT`        | 403                                                  | yes                |
| `SUBMITTED`    | 403                                                  | yes                |
| `UNDER_REVIEW` | 403                                                  | yes                |
| `REJECTED`     | 403                                                  | domain test only   |
| `SUSPENDED`    | 403                                                  | yes — while online |
| `APPROVED`     | 200                                                  | yes                |

Going **offline** is never blocked by status. A suspended expert should not be stuck showing as
available.

**Suspension while online is the case worth reading closely.** Suspending an expert does not itself
write the availability row, so for up to one sweep interval their status still reads `AVAILABLE`.
That is safe _because eligibility is a conjunction_: `NOT_APPROVED` lands the instant the status
changes, so nothing can be dispatched to them in the meantime. The status catches up; the guarantee
never lapses. The e2e asserts exactly this sequence — suspend while available → not eligible
immediately → can still go offline → cannot go available again → reinstate → toggle works.

### 4 — APPROVED is necessary, not sufficient

`evaluateEligibility` is a conjunction and it returns **reasons**, not a boolean:

```
ACCOUNT_NOT_ACTIVE · NOT_APPROVED · NOT_AVAILABLE · PRESENCE_STALE
ALREADY_ON_OFFER · IN_SESSION · NO_MATCHING_SKILLS
```

Every condition is evaluated rather than short-circuited, so the dashboard lists everything wrong at
once instead of making someone fix one thing, reload, and discover the next.

`NO_MATCHING_SKILLS` is declared now and populated in Phase 5, so the matching engine's audit rows
can use the same words the expert reads. That is deliberate: a candidate excluded for a reason the
expert has never seen phrased that way is a support ticket.

A boolean would have answered neither the expert's question ("why am I not getting work?") nor the
dispatcher's ("why did I skip this candidate?").

### 5 — The sweep is sticky

Three independent things make this hold, and the first is the one I would defend hardest:

**The state machine has no edge back into AVAILABLE whose source is `HEARTBEAT_TIMEOUT`.** The only
route into `AVAILABLE` from `OFFLINE` is `MANUAL_TOGGLE` or `ADMIN`. A test asserts that absence
directly, so restoring-on-heartbeat cannot be added by accident later — it would have to be added to
the table on purpose.

**`touchHeartbeat` writes one column.** The port documents it as MUST NOT change
`availabilityStatus`; the Prisma implementation is a single-field update with no branch that could;
the fake obeys the same contract, so the tests are testing the real invariant.

**The client stops pinging when it is offline.** Not a safeguard — the two above are the safeguards —
just an absence of pointless traffic. A ping could not resurrect anyone anyway.

The e2e proves it with time actually passing: online → 45 seconds of silence → swept → heartbeat →
still OFFLINE → three more heartbeats → still OFFLINE → explicit toggle → AVAILABLE.

One detail worth noticing: **presence goes stale before the sweep lands.** In the window between the
timeout and the worker's next pass the status still reads `AVAILABLE`, but `PRESENCE_STALE` is
already in the reasons, so nothing matchable happens to them. Eligibility is computed from the
timestamp, not from the sweep having run — which means a delayed or dead worker degrades matching
accuracy rather than breaking the guarantee.

### 6 — Availability is unmistakable

An expert's income depends on whether they are in the pool, so this is a full-width banner rather
than a status pill: a colour, a headline in plain language (**"You are receiving requests"** /
**"You are not receiving requests"**), and, when they are not eligible, the specific reasons.

The word "AVAILABLE" on its own would have failed: an expert can be AVAILABLE and not matchable,
which is precisely the confusion requirement 4 exists to prevent.

The reason sentences come from the **server** (`REASON_COPY` in the domain, resolved in
`availability-view.ts`), so the mobile client cannot drift into softer wording. The reason **codes**
travel alongside for clients that want their own phrasing.

The sweep is announced, not silent — `aria-live="polite"` on the banner, plus a warning box
explaining what happened and that it will not be undone automatically.

### 7 — Nothing encourages claiming EXPERT on everything

Not a warning message. Four things, none of which is a nag:

- **Each level is anchored to observable behaviour.** "Deep — _You have solved this at scale,
  repeatedly, and could teach it. Pick this sparingly — it is what we match the hardest problems
  on._" That turns the choice into a factual claim rather than a self-assessment of confidence.
- **Nothing is preselected.** Reaching for the top is an act, not a default.
- **A cap of 30 skills.** Generous for a real specialist, short of the whole taxonomy.
- **An incentive that will bite.** Once matching lands, an inflated rating buys requests you decline
  or handle badly. The copy says so: _"an honest answer here means you get the requests you will
  actually enjoy — and few you will want to decline."_

The guidance lives in the domain (`PROFICIENCY_GUIDANCE`) and is served to the client, so there is
one set of definitions rather than one per platform.

### 8 — Post-approval edits cannot touch administrative fields

An **allowlist**, expressed in a type, not `delete input.status` guards. `ExpertProfileEdit` has no
field for status, verification, review notes, submission timestamps, presence, or the denormalised
metrics — so a new administrative column cannot become self-editable by being forgotten.

Three barriers:

| Layer   | Mechanism                                               | What it buys                                                 |
| ------- | ------------------------------------------------------- | ------------------------------------------------------------ |
| Wire    | `updateExpertProfileSchema.strict()`                    | `{"status":"APPROVED"}` is a **400**, not a silent drop      |
| Domain  | `allowlist()` filters to `SELF_EDITABLE_PROFILE_FIELDS` | The actual invariant — testable with no HTTP and no database |
| Adapter | Prisma `data` built field by field, never spread        | A careless second adapter cannot reopen the hole             |

`.strict()` over the default strip is a deliberate choice: a silently-ignored `status` looks to the
caller exactly like a successful privilege escalation.

Editing does **not** send an approved expert back for review. None of the self-editable fields
changes eligibility, and re-approving someone for changing employer is bureaucracy. Edits to an
approved profile are audited, because an approved profile is what customers get matched against.

### 9 — The API is mobile-shaped

Every operation is plain JSON with no dependence on a rendered page:

| Route                                 | Method     | Purpose                                             |
| ------------------------------------- | ---------- | --------------------------------------------------- |
| `/api/v1/expert/workspace`            | GET        | Status + eligibility + skills in **one** round-trip |
| `/api/v1/expert/availability`         | GET, PUT   | Read and set                                        |
| `/api/v1/expert/availability/history` | GET        | Why you went offline                                |
| `/api/v1/expert/heartbeat`            | POST       | Presence; returns the full view                     |
| `/api/v1/expert/skills`               | GET, PUT   | List and declare                                    |
| `/api/v1/expert/skills/[slug]`        | DELETE     | Remove                                              |
| `/api/v1/expert/profile`              | GET, PATCH | Read and edit                                       |
| `/api/v1/admin/experts/[id]/skills`   | GET, POST  | Review and verify                                   |

Three decisions that exist for the phone specifically:

- **`/workspace` returns everything at once.** A phone opening the app should render the banner, the
  toggle, and the skills from one request, not three waterfalled ones.
- **`heartbeat` returns the availability view, not 204.** A client that was swept finds out on its
  very next ping — no second request needed to notice.
- **The server supplies `heartbeatIntervalSeconds` and `heartbeatStaleAfterSeconds`.** Presence
  timing is tunable without shipping a new app build through review.

Nothing is computed client-side that the server could compute: `canGoAvailable`, `eligible`,
`reasons`, and the human-readable `messages` all arrive decided.

### 10 — The manual browser test

At the top of this document.

---

## Notable engineering

**The sticky rule is structural, not defensive.** The absence of an edge in a data table, and a
single-column update in the adapter, are what hold requirement 5 — not a check somewhere that could
be forgotten. A test asserts the absence, so the rule survives someone later "fixing" heartbeats to
be helpful.

**Eligibility is computed from timestamps, not from the sweep.** The sweep is bookkeeping —
it makes the status honest and gives the expert something to read. The dispatcher's decision is
independent of it. A worker that dies makes matching slightly less tidy instead of putting absent
experts back in the pool.

**Optimistic guard on every status change.** `changeStatus` takes `expectedStatus` and uses
`updateMany … WHERE availabilityStatus = expected`. A sweep and a manual toggle racing each other
produce exactly one winner; the loser gets `null` and does nothing rather than clobbering the other.
Both the fake and the Prisma adapter honour this, and there is a test that forces the loss.

**Going offline mid-offer is a conflict, not a state-machine error.** A test surfaced that
`ON_OFFER → OFFLINE` threw `IllegalTransitionError: Illegal state transition`. An expert reading that
learns nothing. It now says: _"A request just came in and is waiting on your answer. Decline it and
you will go offline straight after."_ Offering an escape hatch from an offer already sent would be
worse for the customer than an awkward message is for the expert.

**The sweep leaves `ON_OFFER` alone, on purpose.** The state machine permits
`ON_OFFER → OFFLINE` on timeout, but taking that edge in Phase 4 would abandon an open offer with
nothing to re-dispatch the request. It is also moot: the offer window is 60s and the presence window
180s, so an absent expert times out of the offer long before presence goes stale. Phase 5 takes that
edge, once it can release the request in the same breath. The fake and the adapter agree on this, so
the tests are not passing for the wrong reason.

**The presence sweep is an interval, not a queued job.** Nothing enqueues it; only time passing makes
it due. It is idempotent and cheap — a re-run immediately after a run sweeps nothing, because the
rows it would find are already OFFLINE. `HEARTBEAT_SWEEP` stays in the queue catalogue for the
admin-triggered case.

**`AvailabilityChangeSource` moved to `@sfx/contracts`.** The lint rule caught it: a port had
imported it from a domain module, which inverts the dependency the whole layering rests on. It was
also duplicated in three places (Prisma enum, domain union, an inline Zod enum). Now one definition,
re-exported from the domain file that gives it meaning.

**Presence timings are validated against each other at boot.** `HEARTBEAT_INTERVAL_SECONDS` must be
shorter than `HEARTBEAT_STALE_AFTER_SECONDS`, or every genuinely present expert is swept — a config
error that would look exactly like a broken sweep. It fails at boot with a named variable instead.

**`globalPassThroughEnv` in `turbo.json`.** Turbo strips undeclared environment variables, so
`HEARTBEAT_STALE_AFTER_SECONDS=10 pnpm dev` silently kept the 180s default. Found while setting up
the walkthrough above; the symptom was indistinguishable from a sweep that did not work.

---

## Two bugs caught before they shipped

**1. "0 minutes."** The banner said _"if we have not heard from you for 0 minutes"_ whenever the
window was set short — which is exactly the configuration anyone demonstrating the feature uses.
`Math.round(seconds / 60)` on a 10-second window. Now formats in seconds below 90.

**2. The adapter and the fake disagreed about the sweep query.** The Prisma adapter swept
`AVAILABLE` **and** `ON_OFFER`; the fake swept only `AVAILABLE`. The domain tests would have passed
while production abandoned open offers. Resolved in favour of the fake, with the reasoning written
down where the query is.

---

## Significant files

**New — domain**

| File                                     | Why                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `experts/availability.ts`                | Transition table, `canGoAvailable`, `evaluateEligibility`, `REASON_COPY` |
| `experts/expert-availability-service.ts` | Toggle, heartbeat, sticky sweep, ownership re-checks                     |
| `experts/expert-skill-service.ts`        | Declaration, the 30-skill cap, admin-only verification                   |
| `experts/expert-profile-service.ts`      | The self-editable allowlist and its enforcement                          |
| `ports/expert-repositories.ts`           | Availability, skill and profile ports                                    |
| `experts/in-memory-expert-world.ts`      | Fakes that honour `expectedStatus` and the `touchHeartbeat` contract     |

**New — contracts**

`expert-workspace.ts` — availability, heartbeat, skill and profile schemas.
`primitives.ts` gains `availabilityChangeSourceSchema`. `env.ts` gains the two presence timings with
a cross-field check.

**New — adapters**

`persistence/prisma-expert-repositories.ts` — three repositories, with the guard and the
single-column heartbeat.

**New — web (8 routes, 2 pages, 4 components)**

API: `v1/expert/workspace` · `v1/expert/availability` · `v1/expert/availability/history` ·
`v1/expert/heartbeat` · `v1/expert/skills` · `v1/expert/skills/[slug]` · `v1/expert/profile` ·
`v1/admin/experts/[id]/skills`
Pages: `expert/skills` · `expert/profile` · rewritten `expert`
Components: `availability-panel` · `skills-manager` · `profile-editor` · `admin/skill-verification`
Lib: `availability-view`

**New — worker**

`jobs/heartbeat-sweep.ts` + registration; container gains `ExpertAvailabilityService`.

**New — tests (98 added)**

`availability.test.ts` (30) · `expert-presence.test.ts` (21) · `expert-skills.test.ts` (21) ·
`expert-workspace.test.ts` (17) · `env.test.ts` (+4) · `scripts/e2e/phase4-availability.sh` (61 HTTP
checks)

**Modified**

`policy.ts` (+7 permissions) · `container.ts` (web and worker) · `turbo.json` · `.env.example` ·
`package.json` (`e2e:phase4`) · `expert-application/page.tsx` (links to skills) ·
`admin/experts/[id]/page.tsx` (skill verification panel)

---

## Assumptions

1. **180 seconds, not 60.** Browsers throttle `setInterval` in a background tab to roughly once a
   minute, so a tighter window sweeps experts who are merely on another tab. The cost of being
   generous is a stale expert absorbing at most one offer; the cost of being tight is sweeping people
   who are present and willing.
2. **45-second ping.** Four chances to land inside the window, cheap enough to ignore.
3. **A 30-second sweep cadence.** Worst case an expert is 210 seconds stale before their status is
   corrected — and they are already ineligible for the whole of it.
4. **A cap of 30 skills per expert.** A guess. Revisit if real specialists hit it.
5. **Skills are editable from DRAFT onward.** They are part of what a reviewer assesses, so gating
   them on approval would be backwards. Approval gates _availability_.
6. **`verifiedByUserId` is not on the wire.** The expert needs to know a skill is verified, not which
   admin did it. That stays in the audit log.
7. **A dropped heartbeat shows no error.** The next one is 45 seconds away, and if the network really
   is gone then being swept is the correct outcome.

---

## Deviations from the approved architecture

**None.** Three additions worth recording:

- **`AvailabilityChangeSource` relocated to `@sfx/contracts`** so the ports can name it without
  importing a domain module. Required by the §7 boundary rule, which the lint rule enforced.
- **A second interval in the worker** alongside the Phase 3 classification janitor. Same shape, same
  reasoning: nothing enqueues it, only time makes it due.
- **Two new environment variables**, both defaulted, with a cross-field check at boot.

---

## Remaining TODOs

Unchanged from Phase 3 except where noted.

- **G1 rate limiting** — shared store before public deploy. The heartbeat endpoint is a new
  candidate: it is authenticated and cheap, but it is also the highest-frequency route in the app.
- **G2 storage** · **G3 CSP** · **G4 Sentry** — unchanged.
- **Availability history renders raw status names.** Cosmetic.
- **No push when a sweep happens with the tab closed.** Phase 6 owns notifications; an expert who
  closed their laptop deliberately does not need telling, but one whose wifi dropped does.
- **`NO_MATCHING_SKILLS` is declared and never emitted** until Phase 5 evaluates skills per request.
- **Q2 (pricing numbers)** — still open.
- **Account deletion is still blocked by attachments** (Phase 3 finding, unchanged).

---

## Phase 5 scope, for reference

Matching and dispatch: candidate ranking with primary-skill competence as a **disqualifier**,
relaxation with a floor that is never crossed, the 60-second offer window, the 15-minute matching
deadline, `one_open_offer_per_expert` doing its job under concurrency, and manual admin dispatch.

Phase 4's `evaluateEligibility` is what Phase 5 will ask, and `NO_MATCHING_SKILLS` is the reason it
will start returning.
