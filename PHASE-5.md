# Phase 5 — Matching & Dispatch · Gate Summary

**Status:** Complete. `pnpm verify` 9/9, `pnpm e2e:phase5` 64/64. Stopped before Phase 6.
**Date:** 2026-08-03
**Checkpoints:** Phase 1 `6abcd51`, Phase 2 `5cb8c4e`, Phase 3 `a80b7d8`, Phase 4 `733299a`.
Phase 5 uncommitted, awaiting approval.

This is the phase where the product either works or doesn't. Two things in it changed as a direct
result of testing, and both are worth your attention before anything else:

1. **Weights alone could not deliver requirement 2.** A candidate maxed on rating, tenure, fairness
   and reliability beat a verified EXPERT who was a whole proficiency level stronger at the primary
   skill. Ranking is now **banded** — see requirement 2 below. This is the most consequential
   decision in the phase and I would like you to look at it specifically.
2. **The level-0 secondary-skill filter was set to 100% and made matching unusable.** No real expert
   declares every supporting skill a classifier names, so nothing matched at level 0 and every
   request waited four minutes. Only the end-to-end run found it.

---

## 👀 Requirement 17 — the two-browser walkthrough

### Start the servers with a shorter offer window

Sixty seconds is a long time to sit watching a screen. Twenty makes the timeout observable without
making the accept path a race:

```bash
# terminal 1
pnpm pg:start

# terminal 2
OFFER_WINDOW_SECONDS=20 pnpm dev
```

### Setup — one customer, two experts, one admin (five minutes)

You need three browser profiles (or one window plus two incognito windows).

1. Register four accounts at `/register`: **customer**, **expert-A**, **expert-B**, **admin**.
2. `pnpm grant-role <admin-email> ADMIN`
3. For each expert: `/expert-application` → fill in → **Submit**. Then as admin, `/admin/experts` →
   **Claim** → **Approve**.
4. **This is the step that matters.** As expert-A, go to `/expert/skills` and add
   **Apex → Deep (EXPERT) → 8 years**, plus **Apex Triggers → Strong**. As expert-B, add
   **Apex → Strong (ADVANCED) → 5 years** and **Apex Triggers → Strong**.
5. Both experts: `/expert` → **Go available**. Leave both tabs open.

### The walkthrough

| Step   | Where                      | What to look for                                                                                                                                                                                                       |
| ------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**  | Customer → `/request-help` | Paste: _"Our Apex trigger on Account hits Too many SOQL queries: 101 when we bulk load about 4000 records."_ Submit. You pick no expert and no skills.                                                                 |
| **2**  | Customer → status page     | _"Reading your problem"_ → _"Finding the right Salesforce expert…"_ → _"Expert found — waiting for them to accept"_. Usually under three seconds.                                                                      |
| **3**  | **Expert-A's tab**         | An offer card appears with a **countdown**, the problem text, the skills, and what they earn. Expert-B's tab shows nothing — this is the point of the product.                                                         |
| **4**  | Expert-A                   | Reload the page. **The countdown does not restart** — it picks up where it was. That is requirement 8: the deadline is stored on the offer, not counted in the browser.                                                |
| **5**  | Expert-A                   | Click **Decline** → the reason list appears → click **Decline without a reason**. Skipping is a real button, not a cancel link (requirement 9).                                                                        |
| **6**  | **Expert-B's tab**         | Within ~3 seconds the offer arrives here instead. Expert-A is back in the pool and will never be offered _this_ request again.                                                                                         |
| **7**  | Expert-B                   | Click **Accept**.                                                                                                                                                                                                      |
| **8**  | Customer → status page     | _"Expert found"_, plus a panel: _"We matched you with a Salesforce specialist with 8 years of experience…"_ — and **no name, no photo, no profile link**. §39: we sell access to the right expertise, not a directory. |
| **9**  | Admin → `/admin/requests`  | The in-flight queue. Submit another request from the customer and watch it appear with its relaxation level and time remaining.                                                                                        |
| **10** | Admin → click a request    | **This is requirement 4.** Every run, every candidate, every score component, and every exclusion reason. Read the table and see whether you could answer _"why B and not A"_ from it alone.                           |

### Also worth doing

**Watch a timeout (requirement 10).** Submit a request, let the offer arrive, and _do nothing_.
After 20 seconds the card is replaced by _"That one has gone"_, and the request moves to the next
expert. Then check the admin audit: the attempt reads `TIMED_OUT`, **not** `DECLINED`, with no
reason attached. Silence is not an answer, and the system does not pretend it was one.

**Force Assign (requirement 12).** Give a third expert **Apex → Learning (BEGINNER)** and make them
available. Submit an Apex request — they will be **excluded**, and the admin dispatch panel will show
them greyed with _"primary skill below the floor"_. Now Force Assign to them with a reason. The panel
warns you it is an override; the offer arrives on their screen labelled **"Sent by our team"** with
your reason attached; and **they can still decline it**. That last part is the thing §C5 originally
got wrong and you corrected — an operator overrides every rule and no person.

**The floor holding (requirement 11).** Take every ADVANCED-or-better Apex expert offline, leaving
only the BEGINNER one. Submit an Apex request. It will sit in `SEARCHING` and eventually give up as
`NO_EXPERT_FOUND` — it will never be offered to them, at any relaxation level. That is _"a wrong
expert is worse than no expert"_ as running code.

### Known rough edges

- **Polling, not realtime.** The offer card polls every 3 seconds, so an offer can take up to 3s to
  appear. Phase 6 replaces this with Ably plus browser push and sound. §17 rules out polling as the
  _dispatch_ mechanism, which this is not — dispatch is durable pg-boss timers.
- No notification when an offer arrives while the tab is backgrounded. Phase 6.
- The admin matching table is dense. It is built for answering a specific question, not for browsing.
- `NO_EXPERT_FOUND` does not yet void the payment authorization — Phase 7a owns that.

---

## Gate results

```
── verify ──                                  ── e2e (real HTTP) ──
  ✓ format                                          phase2:  41 passed, 0 failed
  ✓ lint                                            phase3:  27 passed, 0 failed
  ✓ typecheck                                       phase4:  61 passed, 0 failed
  ✓ test                                            phase5:  64 passed, 0 failed
  ✓ local postgres available
  ✓ migrations apply to a fresh database
  ✓ dev database is migrated and seeded
  ✓ web builds
  ✓ worker boots
```

| Gate requirement | Result                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------- |
| Tests            | **428 passing** (was 264) — 379 domain, 29 contracts, 20 adapters                        |
| New this phase   | 156 matching tests + 7 real-Postgres concurrency tests + 64 HTTP checks                  |
| Lint             | Clean, 7 packages, 0 errors                                                              |
| TypeScript       | `tsc --noEmit` clean, `strict` + `noUncheckedIndexedAccess`                              |
| Migrations       | 1 new (`matching_audit_fields`), applies to a fresh database, 6 partial indexes asserted |
| Build / boot     | Web builds 43 routes; worker runs 4 handlers + 3 janitors                                |

**Exit criterion met:** a customer submits a Salesforce problem choosing nobody; the engine filters,
scores and ranks the bench; the best-qualified available expert is offered the work; declining moves
it to the next; accepting assigns it and the customer's request reflects that — all verified over
HTTP with real cookies, including a real 20-second timeout elapsing.

---

## Requirement 2, in detail — because this is where the design changed

You asked that primary-skill competence be _both_ a hard floor _and_ dominant in ranking, and
specifically that strong secondaries, tenure, rating, fairness or reliability must not let a
materially weaker primary-skill expert outrank a substantially stronger one.

**I implemented that as weights first, and it does not work.** The regression test in
`fairness.test.ts` was written to prove the property and instead disproved it:

|           | primary                   | skill | rating | exp   | fair  | rely  | **final** |
| --------- | ------------------------- | ----- | ------ | ----- | ----- | ----- | --------- |
| Strong    | CPQ **EXPERT** (verified) | 0.942 | 0.900  | 0.780 | 0.000 | 0.654 | **0.739** |
| Maxed-out | CPQ **INTERMEDIATE**      | 0.617 | 0.980  | 1.000 | 1.000 | 0.999 | **0.843** |

The arithmetic is not close. One proficiency level of primary skill is worth about **0.13** of the
final score; the four non-technical axes together can move it by about **0.21**. No weight table
that keeps fairness meaningful can also make competence dominant — the two requirements pull against
each other, and weights are a single dial trying to serve both.

**So ranking is banded.** Candidates are sorted first by the _ordinal proficiency level of their
weakest primary skill_, and only within a band by `finalScore`:

```
compare(a, b):
  1. primaryBand        ← requirement 2. Nothing below this line can cross a band.
  2. finalScore         ← requirement 3. Everything still matters, inside a band.
  3. minPrimaryValue
  4. idleMinutes
  5. seeded hash of the expert id
```

That gives both halves of what you asked for, and gives them structurally rather than by tuning:

- **Across bands, competence is absolute.** An ADVANCED expert never outranks an EXPERT one for that
  request, however long they have waited or however well they are rated.
- **Inside a band, fairness bites.** The §14 case still resolves the way you specified — B wins by
  0.087 on fairness alone.
- **"Materially weaker" now has a definition:** a whole declared proficiency level lower. That is the
  granularity the expert themselves chose on their skills page, which makes it explainable to them.
- **Verification cannot promote anyone.** The band uses the _declared_ level, not the
  verified-adjusted value, so verification helps inside a band and is never the thing that gets an
  expert work (requirement 5).

Same lesson as the floor itself, one layer up: a guarantee you care about has to be structural, not a
number someone can retune six months from now without realising what it was holding.

---

## Requirement 16 — worked examples

Generated from the real scoring code, not hand-computed.

### Example 1 — the Copado disqualification (requirement 2, 11)

Request: **Copado** _(primary)_, Git, Metadata Deployment.

| Expert         | Copado   | Git          | Deploy   | Other                              | Verdict                        |
| -------------- | -------- | ------------ | -------- | ---------------------------------- | ------------------------------ |
| A — specialist | EXPERT   | ADVANCED     | ADVANCED | 7y, 4.4★, idle 30m                 | **ranked #1**, final **0.750** |
| B — generalist | BEGINNER | INTERMEDIATE | EXPERT   | 14y, 4.9★, idle 8h, 39/40 accepted | **excluded**                   |

B's exclusion reason: `PRIMARY_BELOW_FLOOR`, marked **permanent**.

At relaxation **0, 1, 2 and 3** — every level that exists — the outcome is identical. B is better than
A on tenure, rating, idle time and acceptance rate, and never becomes a candidate. Note also that at
level 3 secondary skills widen to the parent category, and `metadata-deployment` (EXPERT, same
category as Copado) still cannot stand in for the primary.

### Example 2 — fairness deciding between near-equals (§14, requirement 3)

Request: **Apex** _(primary)_, Apex Triggers.

| Expert                    | Apex     | band | skill | rating    | exp       | fair      | rely  | **final** |
| ------------------------- | -------- | ---- | ----- | --------- | --------- | --------- | ----- | --------- |
| **B** — 7y, 4.8★, idle 3h | ADVANCED | 2    | 0.750 | 0.948     | 0.770     | **0.750** | 0.881 | **0.806** |
| A — 8y, 4.9★, idle 10m    | ADVANCED | 2    | 0.750 | **0.964** | **0.880** | 0.042     | 0.881 | 0.719     |

B wins by **0.087**, and the entire margin is fairness — A is ahead on rating and experience, and
those are preserved in the record rather than discarded. Same band, so the score decides.

### Example 3 — fairness cannot rescue a weaker primary (requirement 3)

Request: **CPQ** _(primary)_, Billing. Relaxation 2, so INTERMEDIATE clears the floor and this is a
genuine ranking contest rather than a filter one.

| Expert    | CPQ               | band  | skill | rating | exp   | fair  | rely  | final     | **rank** |
| --------- | ----------------- | ----- | ----- | ------ | ----- | ----- | ----- | --------- | -------- |
| strong    | EXPERT (verified) | **3** | 0.942 | 0.900  | 0.780 | 0.000 | 0.654 | 0.739     | **#1**   |
| maxed-out | INTERMEDIATE      | **1** | 0.617 | 0.980  | 1.000 | 1.000 | 0.999 | **0.843** | #2       |

The weaker candidate has the **higher final score** and still loses. This is the example that forced
banding, and the table is in the gate report deliberately: it is the one place where the score and
the ranking disagree, and anyone reading the code later needs to know that is on purpose.

### Example 4 — verification helps inside a band, never across one (requirement 5)

| Expert                | CPQ        | band | skill | **final** | rank   |
| --------------------- | ---------- | ---- | ----- | --------- | ------ |
| bare EXPERT           | EXPERT     | 3    | 0.942 | 0.863     | **#1** |
| **verified** ADVANCED | ADVANCED ✓ | 2    | 0.808 | 0.810     | #2     |
| bare ADVANCED         | ADVANCED   | 2    | 0.750 | 0.787     | #3     |

Verification lifts the ADVANCED expert above their unverified peer (0.808 vs 0.750 on skill) and
never above the EXPERT one. So verification is worth having and is not a prerequisite for work —
which is what requirement 5 asked for.

### Example 5 — relaxation over a thin bench (requirements 11, 1)

Request: **Apex** _(primary)_, Apex Triggers. Only two experts online.

| Level | Floor        | INTERMEDIATE expert                                   | BEGINNER expert (idle 16h) |
| ----- | ------------ | ----------------------------------------------------- | -------------------------- |
| 0     | ADVANCED     | excluded — `PRIMARY_BELOW_FLOOR`, _may qualify later_ | excluded — **permanent**   |
| 1     | ADVANCED     | excluded                                              | excluded — **permanent**   |
| 2     | INTERMEDIATE | **ranked #1**, final 0.675                            | excluded — **permanent**   |
| 3     | INTERMEDIATE | ranked #1                                             | excluded — **permanent**   |

Two things to notice. The INTERMEDIATE expert's exclusion is marked _"may qualify later"_ and the
BEGINNER's _"permanent"_ — the system knows the difference and says so, so nothing waits for someone
who can never qualify. And the BEGINNER expert, idle for sixteen hours with nobody else available,
is still never offered the work.

### Example 6 — the offer sequence, end to end

From the e2e run, three experts online:

```
t+0.0s  customer submits, no skills selected            → CREATED → CLASSIFYING
t+0.1s  classified: apex (primary) · triggers,
        soql-sosl, governor-limits (secondary)          → SEARCHING
t+0.1s  run 1, relaxation 0, floor ADVANCED
          ranked   #1 deep      (apex EXPERT)    0.72
          ranked   #2 good      (apex ADVANCED)  0.69
          EXCLUDED    generalist (apex BEGINNER) PRIMARY_BELOW_FLOOR  ← permanent
          EXCLUDED    5 others                   NOT_AVAILABLE
t+0.2s  offer → deep, expires t+20.2s                   → OFFERED
t+1.1s  deep accepts (0.9s response)                    → ACCEPTED
        good's attempt → SUPERSEDED
        deep → IN_SESSION, run 1 completed
```

And the decline path on the next request:

```
t+0.2s  offer → good, expires t+20.2s                   → OFFERED
t+2.0s  good declines, reason TOO_COMPLEX               → SEARCHING
        good → AVAILABLE, added to the responded list
t+2.1s  re-dispatch: good is skipped (ALREADY_RESPONDED)
        no other candidate at level 0 → wait for the schedule
```

---

## Your seventeen requirements, as built

### 1 — Five separate stages

| Stage                        | Where                                             | Pure?                                   |
| ---------------------------- | ------------------------------------------------- | --------------------------------------- |
| 1. eligibility filtering     | `matching/filters.ts` → `filterEligibility`       | yes                                     |
| 2. hard competence filtering | `matching/filters.ts` → `filterCompetence`        | yes                                     |
| 3. scoring and ranking       | `matching/scoring.ts`, `matching/rank.ts`         | yes                                     |
| 4. dispatch                  | `matching/matching-service.ts`                    | no — needs a clock, a database, a queue |
| 5. controlled relaxation     | `matching/relaxation.ts`, driven from the service | table is pure                           |

Stages 1–3 are pure functions over plain data. The whole scenario list runs in **83 milliseconds**
with no database, which is what makes it cheap to assert properties rather than examples.

Stage 1 delegates to the same `evaluateEligibility` the expert's own dashboard uses, so the words an
expert reads about themselves and the words in the matching audit come from one function and cannot
disagree.

### 2 — Primary competence is a floor _and_ dominates ranking

See the section above. Floor in `filterCompetence`, dominance in `compareCandidates` via
`primaryBand`.

Two ways to fail the floor, kept as separate reasons because they mean different things to an
operator: `MISSING_PRIMARY_SKILL` ("never claimed it") and `PRIMARY_BELOW_FLOOR` ("claimed it, not
deep enough"). Category substitution — the level-3 widening — is **never** offered for a primary
skill, and a substitute may never be a skill the request already asks for elsewhere. That second rule
came from a test: without it one declaration got counted twice, once as itself and once standing in
for something else, which inflated exactly the candidates the floor exists to hold back.

### 3 — Fairness among similar candidates, and only there

Both regression tests you asked for, plus the reason they are two-sided:

- _"a slightly less technically matched expert who has waited much longer can win when candidates are
  close"_ → Example 2. B wins by 0.087, all of it fairness.
- _"fairness cannot cause a materially weaker technical candidate to beat a clearly stronger one"_ →
  Example 3, which fails on weights alone and passes on banding. The test asserts the uncomfortable
  fact directly: `expect(scoreWeak.finalScore).toBeGreaterThan(scoreStrong.finalScore)` **and**
  `expect(rank(...)[0]).toBe("strong")`.

Fairness itself is two terms: idle time rising to 1 over a four-hour horizon, discounted by up to 30%
for sessions already worked today. A never-offered expert reads as maximally idle rather than as
zero, so a new expert is not starved by a metric that only starts counting after their first offer.

### 4 — The score is explainable, and the explanation is persisted

`GET /api/v1/admin/requests/:id/matching` and the page at `/admin/requests/:id` answer _"why B and
not A"_ from stored data alone. What is written, per run:

- `weightsSnapshot` and `thresholdsSnapshot` — §C7. A weight change next month cannot rewrite the
  reasoning behind a decision made today.
- `filtersApplied` — the floor, coverage, and which gates were in force.
- One `MatchingAttempt` per candidate **including the excluded ones**. That is the new part: ranked
  experts were already recorded, but experts a filter rejected left no trace at all — and "why wasn't
  Priya offered this?" is the question an operator actually asks.
- Per attempt: all five components, the final score, and a `scoreBreakdown` with the per-skill detail,
  the shrunk rating, the acceptance rate, the idle minutes, and `primaryBand`.
- `exclusionReasons` — **every** failing reason, not the first. An answer that names one problem when
  there were three is a misleading answer.

The e2e recomputes the total from the persisted components _and_ the persisted weight snapshot and
asserts they agree to within 0.002. An audit row that cannot reproduce its own conclusion explains
nothing.

### 5 — Verification improves confidence, never gatekeeps

A 10% multiplier on the proficiency value, capped at 1.0. Deliberately small enough that it separates
two experts at the same level and can never promote one past another — verified ADVANCED is 0.825,
still below a bare EXPERT's 1.0. And the ranking band uses the declared level, so verification cannot
move anyone between bands even in principle. Example 4 shows both halves.

### 6 — Concurrency, against a real Postgres

`packages/adapters/src/persistence/offer-concurrency.test.ts`, 7 tests, real database.

Two requests dispatching to the same top-ranked expert concurrently → exactly one offer, and the
loser's dispatcher falls through to the next candidate rather than failing. Plus a ten-way stampede,
plus a decline racing a timeout producing one winner.

**One finding worth reporting.** The first six tests go through `openOffer`, which guards on
`availabilityStatus` as well as writing the attempt. I dropped
`one_open_offer_per_expert` on a throwaway database to check the tests were testing what I claimed —
and **only the seventh failed**. The other six were satisfied by the availability lock alone. So there
is now a test that writes both `OFFERED` rows directly, bypassing the service path, because that is
the only way to hold the index itself to account. The comment in the file records the experiment.

### 7 — The 15-minute deadline is measured from submission to acceptance

`matchDeadlineAt` is set once, at creation, and no code path recomputes it. Asserted three ways:
across an offer expiring, across a relaxation level changing, and across a manual re-assignment.

Every dispatch re-reads it before offering, so the stored value is the authority and the scheduled
job is only a backstop. An offer window is also clamped so it can never outlive the deadline — a
60-second window opening at t+14m50s would keep a customer waiting past the promise.

### 8 — The 60-second window is durable

`offerExpiresAt` is a stored column, not a property of a scheduled job. Consequences, each tested:

- A browser refresh re-reads the same deadline. The countdown ticks toward an absolute instant, so it
  cannot restart.
- A duplicate job delivery finds the window still open, **re-schedules for the remaining time**, and
  does not expire the offer or extend it.
- A worker restart replays the job against the same stored value.
- The timeout handler contains no arithmetic at all — it reads and compares.

The client-side countdown is a subtraction from an absolute timestamp rather than a decrement, so a
backgrounded tab that misses ticks shows the right number when it returns.

### 9 — Structured decline reasons, never required

The five you listed, in `DeclineReason`. Optional at every layer: the Zod schema, the service, the
column. The UI makes skipping a first-class action — **"Decline without a reason"** is a button, not
a cancel link.

An expert who must justify saying no starts saying yes to work they should not take, and the entire
product rests on them not doing that.

### 10 — Declines and timeouts are distinct

Separate statuses (`DECLINED`, `TIMED_OUT`), separate code paths, separate meanings. A timeout never
carries a decline reason. The e2e asserts the pair explicitly:

```
[["expA", "DECLINED", "TOO_COMPLEX"], ["expB", "TIMED_OUT", null]]
```

There is a third: `WITHDRAWN`, for an offer pulled before the expert could answer — suspended, swept
offline, superseded by an admin, or still open at the deadline. Withdrawals **never count against
acceptance rate**, and because `offersReceived` is incremented at offer time, that means decrementing
it back.

### 11 — Relaxation can never cross the floor

`ABSOLUTE_PRIMARY_FLOOR = INTERMEDIATE`, applied by `floorForLevel` rather than trusted to the ladder
table, so a well-meaning edit cannot lower it. Tested as a **property**: across every declared level,
and across levels that do not exist (`-5`, `4`, `99`, `NaN`, `Infinity` — an out-of-range level clamps
to the _strictest_ rule, not the loosest, because "level 7 means no floor" is precisely the failure
this exists to prevent).

`NO_EXPERT_FOUND` is reached rather than offering to someone below the floor. Example 5 shows a
BEGINNER expert idle for sixteen hours, the only person available, never offered the work.

### 12 — Assign and Force Assign, neither bypassing consent

|                              | Assign  | Force Assign                          |
| ---------------------------- | ------- | ------------------------------------- |
| Overrides ranking            | yes     | yes                                   |
| Overrides competence filters | no      | **yes**                               |
| Overrides availability       | no      | **yes** — can reach an OFFLINE expert |
| Requires a written reason    | yes     | yes                                   |
| Audited                      | yes     | yes                                   |
| **Expert must accept**       | **yes** | **yes**                               |

§C5 originally sent Force Assign straight to `ACCEPTED`. You overruled that in Phase 2 and I have
updated `ARCHITECTURE.md` to match, with the reasoning recorded. Force Assign now produces an
ordinary offer with the ordinary window and the ordinary buttons; the expert may decline it, and the
e2e asserts exactly that. **There is no parameter anywhere that skips consent.**

Force Assign needed one new availability edge: `OFFLINE → ON_OFFER`, source `ADMIN` only. The
dispatcher can never take it, which is what keeps the automation honest while letting an operator who
has already phoned someone make the system catch up.

`extend-deadline` from §C5 is **not built**. Requirement 7 fixes the window at submission, and the
only honest reason to extend it is a customer agreeing to wait longer — which is a conversation, not
a button. Deferred, not dropped.

### 13 — Manual and algorithmic are distinguishable forever

- `MatchingAttempt.origin` — `ALGORITHMIC` / `ADMIN_ASSIGN` / `ADMIN_FORCE_ASSIGN`.
- `rank` is **null** for a manual attempt, because it bypassed the ranking by definition.
- `adminReason` carries the operator's words.
- Distinct audit actions (`matching.assigned` / `matching.force_assigned`) naming the admin, and
  recording the consent rule in the row itself.
- Visible in the admin table as a **manual** badge, and to the _expert_ as **"Sent by our team"**
  with the reason. Withholding that from the expert would make a manual assignment feel algorithmic,
  which is worse than either.

### 14 — Becoming ineligible mid-dispatch never strands a request

Four distinct cases, each handled where it arises:

| Case                                                               | Mechanism                                                                                                                                                                        |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Went offline / took another offer **between ranking and offering** | `openOffer` guards on `availabilityStatus`; returns null, attempt → `WITHDRAWN`, dispatcher tries the next candidate                                                             |
| Suspended or swept **while holding an offer**                      | `reconcileStaleOffers`, on the worker's 30s janitor — withdraws, returns them to OFFLINE, puts the request back to SEARCHING. This closes the gap Phase 4 deliberately left open |
| Two dispatchers racing for one expert                              | `one_open_offer_per_expert` → `ConflictError` → next candidate                                                                                                                   |
| A dispatch enqueue lost entirely                                   | `recoverStalledSearches`, same janitor — a `SEARCHING` request with no open offer and no activity for one offer-window is re-dispatched                                          |

None of these count against the expert's reliability. A presence problem or an operator's decision is
not a decline.

### 15 — Not over-engineered

Deterministic weighted scoring plus hard filters plus a banded sort. No learned ranking, no
embeddings, no vector search, no solver, no recommendation model. The weights are configuration and
the whole thing is 5 pure files totalling under 700 lines.

The one place I added structure beyond weights is the band, and that was forced by a failing test
rather than chosen — see requirement 2.

### 16 — Worked examples

Above. Generated from the implementation so they cannot drift from it.

### 17 — Two-browser walkthrough

At the top of this document.

---

## Notable engineering

**The database narrows; the domain decides.** `findCandidates` filters on `status = APPROVED` and
"holds at least one required skill", and nothing else. An offline or stale expert comes back from
Postgres and is excluded _in TypeScript_, with a reason, so the audit trail can say "we looked at
them and here is why not". Filtering them in SQL would make them invisible to the very question the
audit exists to answer, and would let a query-plan change quietly alter who gets chosen.

**Every write in the dispatch loop is guarded on the state it read.** `openOffer` guards on
`status = RANKED` and on availability; `closeOffer` guards on `status = OFFERED`; `applyTransition`
guards on `version`. That is what makes a decline racing a timeout produce one winner and one no-op
rather than a corrupted row, and it is why every handler is safe to redeliver.

**The fakes model the database's invariants, not a convenient subset.** `FakeMatchingRepository`
throws `ConflictError` when an expert already holds an offer, refuses to offer to someone who is not
AVAILABLE, and guards `closeOffer` on the current status. Without the first of those, the
dispatcher's "try the next candidate" path would never be exercised by a test at all.

**Relaxation is driven by the pool, capped by the clock.** The dispatcher steps up a level when it
runs out of candidates, not when the schedule says so — but never past the level the schedule has
reached. So a search that burns through three candidates in ten seconds waits rather than arriving at
maximum relaxation immediately, because the point of relaxing is to trade quality for time and no
time has passed. Re-ranking on each step means an expert who came online mid-search is picked up.

**The offer window can never outlive the matching deadline.** Clamped at offer time.

**Rounding at every component, deliberately.** Three decimal places, applied per component rather
than only to the total, so an admin reading the persisted numbers arrives at exactly the persisted
total rather than something 1e-16 away from it.

**Ties break on a seeded hash, not on row order.** Without it, the "fairest" expert among equals would
depend on the query plan. The seed is the request id, so re-ranking at a higher relaxation level
breaks ties the same way rather than reshuffling the bench.

**The expert sees an offer; the admin sees the run.** Two wire shapes on purpose. An expert is never
shown their score or their rank — telling someone they were third choice costs the relationship and
buys nothing. The operator is shown everything, because a system nobody can interrogate is a system
nobody can trust.

**The worker enqueues through the boss it already started.** Passing the scheduler into
`buildWorkerContainer` rather than constructing a second `SendOnlyBoss` — one connection pool, one
thing to shut down.

---

## Four things testing changed

**1. Weights could not deliver requirement 2.** The headline finding; see above. Ranking is banded.

**2. Level-0 secondary coverage of 100% made matching unusable.** A classified request names three or
four supporting skills; no real expert declares all of them; nothing matched at level 0 and every
request waited four minutes to relax. The unit tests all used two-skill requests, so only the
end-to-end run with the real classifier exposed it. Coverage is now 0.25 at level 0 — which for three
or four supporting skills means _at least one_ — and the score, not the filter, rewards fuller
coverage. Chosen at 0.25 rather than 1/3 because a threshold sitting exactly on a common fraction
excludes the case it was written to admit: 1/3 = 0.333 fails a 0.34 test.

**3. Category substitution double-counted a skill.** At level 3 a secondary skill may be covered by a
sibling in the same category — and the sibling could be the request's own primary skill, counted once
as itself and again as a stand-in. Caught by a test asserting a specific `value` and getting 1.0
instead of 0.75. A substitute may now never be a skill the request already asks for.

**4. The concurrency tests were passing on the wrong mechanism.** Six of seven still passed with the
partial unique index dropped. Recorded in requirement 6 above; the fix was a test that writes at the
lowest level available.

---

## Significant files

**New — domain (`packages/domain/src/matching/`, 6 files, 156 tests)**

| File                          | Why                                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------- |
| `proficiency.ts`              | The competence ladder. One definition shared by the floor and the score, so they cannot drift |
| `relaxation.ts`               | The ladder, with `ABSOLUTE_PRIMARY_FLOOR` enforced in code rather than in the table           |
| `scoring.ts`                  | Five pure components, the weakest-primary term, and `primaryBand`                             |
| `filters.ts`                  | Stages 1–2, producing every failing reason as a typed code                                    |
| `rank.ts`                     | Stage 3 — the banded comparator, and the truncation that never truncates the audit            |
| `matching-service.ts`         | Stages 4–5: dispatch, accept, decline, timeout, deadline, reconcile, admin dispatch           |
| `in-memory-matching-world.ts` | Fakes that model the index, the guards and the availability lock                              |

Tests: `scoring.test.ts` (22) · `fairness.test.ts` (15) · `filters.test.ts` (59) ·
`dispatch.test.ts` (60)

**New — adapters**

`persistence/prisma-matching-repositories.ts` — the candidate query and the guarded writes.
`persistence/offer-concurrency.test.ts` — 7 tests against a real Postgres.

**New — contracts**

`matching.ts` — the offer view, the audit view, admin dispatch. `primitives.ts` gains
`exclusionReasonSchema`, `attemptStatusSchema`, `attemptOriginSchema`, `declineReasonSchema`.
`env.ts` gains `OFFER_WINDOW_SECONDS`.

**New — web (4 routes, 2 pages, 2 components)**

API: `v1/expert/offer` (GET/POST) · `v1/admin/requests` · `v1/admin/requests/[id]/dispatch`
(GET/POST) · `v1/admin/requests/[id]/matching`
Pages: `admin/requests` · `admin/requests/[id]`
Components: `expert/offer-panel` · `admin/dispatch-panel`
Lib: `matching-view`

**New — worker**

`jobs/dispatch.ts` — three handlers and two janitors. `index.ts` registers
`DISPATCH_NEXT_OFFER`, `OFFER_TIMEOUT`, `MATCHING_DEADLINE`.

**Migration**

`20260802160000_matching_audit_fields` — `EXCLUDED` status, `exclusionReasons`, `offerExpiresAt`,
the `DeclineReason` enum, and `attempt_open_offer_idx`.

**Modified**

`policy.ts` (+5 permissions) · `state-machine.ts` (unchanged — every edge was already declared) ·
`availability.ts` (+`OFFLINE → ON_OFFER` for ADMIN) · `request-repositories.ts` (+`assignExpert`) ·
`requests.ts` (+`matchedExpert`) · `request-status.tsx` · both containers · `ARCHITECTURE.md`
(§C5 and the ranking section) · `assert-schema.mjs`

---

## Assumptions

1. **A whole proficiency level is what "materially weaker" means.** It is the granularity an expert
   chose themselves, so it is explainable to them. A finer definition would make the band boundary
   arbitrary; a coarser one would let real gaps be traded away.
2. **The offer window is clamped to the matching deadline**, so a late offer gets less than 60
   seconds rather than overrunning the promise. The expert is shown the real number.
3. **`sessionsToday` counts sessions created since UTC midnight.** Wrong for an expert in IST by up
   to 5.5 hours. Fixing it properly needs their timezone, which we have — deferred as cosmetic until
   the fairness signal is worth tuning.
4. **The candidate query fetches 50 rows or 5× the pool size.** Fine for a launch roster; the load
   test on this query is a Phase 11 gate.
5. **Polling at 3 seconds for the offer card.** Replaced by realtime in Phase 6.
6. **`NO_EXPERT_FOUND` does not void the authorization yet.** Phase 7a owns the money.
7. **An expert accepting goes to `IN_SESSION` immediately**, not to a "committed" state. There is no
   session object until Phase 8, and leaving them `ON_OFFER` would let the reconciler withdraw an
   offer they had already accepted.

---

## Deviations from the approved architecture

**Two, both recorded in `ARCHITECTURE.md`:**

- **Banded ranking** replaces score-only ranking. §13 implied weights would deliver C3's intent in
  the ranking as well as the filter; testing showed they cannot. The doc now carries the arithmetic.
- **Force Assign does not skip the offer.** §C5 said it did; you overruled that in Phase 2. The doc
  now says so and explains why.

**One thing not built:** `extend-deadline`.

---

## Remaining TODOs

- **G1 rate limiting** — shared store before public deploy. `POST /api/v1/expert/offer` joins the
  list of endpoints that need it.
- **G2 storage** · **G3 CSP** · **G4 Sentry** — unchanged.
- **`sessionsToday` is UTC-based** (assumption 3).
- **The candidate query has not been load-tested.** Phase 11 gate.
- **No realtime, push, or sound on an incoming offer.** Phase 6 — and it is the difference between
  an expert who answers in 8 seconds and one who misses the window.
- **`avgResponseSeconds` is never written.** `reliabilityScore` reads it and falls back to a neutral
  0.5 for everyone. Phase 9 recomputes metrics on session completion; until then the speed term is
  inert.
- **Ratings are all zero**, so `ratingScore` sits at the 4.5 prior for every expert and the rating
  floor never excludes anyone in practice. Phase 9.
- **Account deletion is still blocked by attachments** (Phase 3 finding, unchanged).
- **Q2 (pricing numbers)** — still open.

---

## Phase 6, for reference

Realtime (Ably), browser push, sound, and the email fallback — plus the customer's "Finding the right
expert…" becoming genuinely live rather than polled. **That is the MVP checkpoint**, and per your
Phase 1 review I will stop there and write an assessment of the core loop before Phase 7: what the
dispatch actually feels like end to end, where the latency sits, whether 60 seconds is right, and
whether the ranking produces sensible choices on seeded data.

Two things I would want to look at in that assessment, both visible already:

- **The relaxation schedule may be too slow.** Levels engage at 0/4/8/12 minutes, so a request that
  exhausts a thin bench in the first ten seconds waits four minutes before INTERMEDIATE experts are
  even considered. With a launch roster of 10–20 experts (Q14) that may be most requests.
- **`reliabilityScore` and `ratingScore` are inert until Phase 9.** Two of the five components are
  currently constants, which means the ranking is effectively skill + experience + fairness. Worth
  knowing before drawing conclusions about the weights.
