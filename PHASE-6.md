# Phase 6 — Realtime Dispatch · Gate Summary and MVP Assessment

**Status:** Complete. `pnpm verify` 9/9, `pnpm e2e:phase6` 41/41. **This is the MVP checkpoint.**
**Date:** 2026-08-03
**Checkpoints:** Phase 1 `6abcd51`, 2 `5cb8c4e`, 3 `a80b7d8`, 4 `733299a`, 5 `e09e888`.
Phase 6 uncommitted, awaiting approval.

The core loop is live end to end: a customer describes a Salesforce problem, chooses nobody, and
within about half a second an offer is on the right expert's screen with a sound. The MVP assessment
you asked for is at the bottom, with measured numbers.

**Finding 1 is now applied.** The assessment surfaced that secondary-skill coverage as a hard filter
cost a well-qualified expert a measured 180 seconds; you approved removing it, and
`secondaryCoverage` is 0 at every relaxation level in this checkpoint. Secondary alignment remains an
important part of `skillScore` and therefore of ranking. The primary-skill floor and the banded
primary-skill ranking are unchanged.

---

## 👀 Requirement 17 — the two-browser MVP walkthrough

### Start

```bash
# terminal 1
pnpm pg:start

# terminal 2 — realtime on, and a 20s offer window so a timeout is watchable
REALTIME_PROVIDER=postgres OFFER_WINDOW_SECONDS=20 pnpm dev
```

The worker logs `realtime ready {"provider":"postgres"}` at boot. Realtime needs **no API key** —
it runs on Postgres `LISTEN`/`NOTIFY` over the connection you already have.

### Setup — three browser windows (five minutes)

1. Register four accounts at `/register`: **customer**, **expert-A**, **expert-B**, **admin**.
2. `pnpm grant-role <admin-email> ADMIN`
3. Each expert: `/expert-application` → fill in → **Submit**. As admin: `/admin/experts` →
   **Claim** → **Approve**.
4. Each expert, on `/expert/skills`, adds **Apex (Deep for A, Strong for B)** and a couple of
   related skills. Since finding 1 was applied, an expert with only `apex` is now matched too — the
   supporting skills affect their _ranking_, not whether they are considered at all.
5. Each expert: `/expert` → **Go available**. Then press **Enable sound** and **Enable notifications**
   and accept the browser prompt. Leave both tabs open, expert-B's visible on screen.

### The walkthrough

| Step   | Where                                        | What to look for                                                                                                                                                                                                                                                 |
| ------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**  | Expert tabs                                  | The alerts bar reads **Sound on** and **Notifications on**. You heard a two-note tone when you enabled sound — that is the offer tone.                                                                                                                           |
| **2**  | Expert tabs                                  | Below it: _"No requests right now… **Connected — offers arrive instantly.**"_ That is the SSE stream reporting itself live.                                                                                                                                      |
| **3**  | Customer → `/request-help`                   | Paste: _"Our Apex trigger on Account hits Too many SOQL queries: 101 when we bulk load about 4000 records."_ Submit.                                                                                                                                             |
| **4**  | **Expert-A's tab — do not touch it**         | Within about a second the offer card appears **on its own**, the tone plays, and a notification arrives reading **"New Salesforce support request — Apex · Apex Triggers · Governor Limits — open to review."** No customer text anywhere in it (requirement 7). |
| **5**  | **Expert-B's tab**                           | Nothing. No card, no sound, no notification. Requirement 18.                                                                                                                                                                                                     |
| **6**  | Customer's status page                       | Already moved to _"Expert found — waiting for them to accept"_, live, with _"Updating live"_ underneath. You did not reload.                                                                                                                                     |
| **7**  | Expert-A                                     | Reload the page. **The countdown does not restart.** Requirement 15 — the deadline is a stored column, not a browser timer.                                                                                                                                      |
| **8**  | Expert-A                                     | Click **Accept**.                                                                                                                                                                                                                                                |
| **9**  | **Customer's status page — do not touch it** | Flips to **"Expert found"** with _"They have accepted and are being set up with your session"_, plus the thin disclosure: _"a Salesforce specialist with 8 years of experience…"_ — and no name, no photo, no link (§39).                                        |
| **10** | Admin → `/admin/requests` → click it         | Every run, every candidate, every score, every exclusion reason.                                                                                                                                                                                                 |

### Requirement 18 — the seven things to also demonstrate

| Property                                              | How to see it                                                                                                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B does not get A's offer**                          | Step 5 above. Also: with A's card open, `/api/v1/expert/offer` as B returns `null`.                                                                                                   |
| **Customer B cannot observe customer A**              | Register a second customer, open their dashboard, submit nothing. Their stream stays silent through the whole flow above, and `/api/v1/requests/<A's id>` returns 403.                |
| **Duplicate/replayed signals do not duplicate state** | Click **Accept** three times fast. One acceptance, one `ACCEPTED` attempt, no error on the second and third.                                                                          |
| **Refresh does not restart the countdown**            | Step 7.                                                                                                                                                                               |
| **Disconnect/reconnect reconciles**                   | With an offer open, devtools → Network → **Offline** for 5 seconds, then back online. The card is still there with the _correct_ remaining time — not 20 seconds again.               |
| **An expired offer cannot be resurrected**            | Go offline, wait past the window, come back online. The card is replaced by _"That one has gone"_. Clicking accept from a stale tab returns a conflict.                               |
| **Provider failure does not break dispatch**          | Restart with `REALTIME_PROVIDER=mock`. No stream, no sound, no notification — and every offer still arrives on the dashboard within 15 seconds, still expires on time, still accepts. |

### Known rough edges

- **Realtime needs a long-lived process.** `LISTEN` cannot be held by a serverless function. Fine
  for a container or a VM; a Vercel-style deployment needs the hosted adapter the port exists for.
- Notifications are foreground-only — no service worker, so nothing arrives with the tab closed.
  Email covers that case, late and on purpose.
- The sound is synthesised (two sine notes). It is functional, not designed.
- `REALTIME_PROVIDER=ably` deliberately **fails at boot**. There is no adapter, and silently falling
  back to something else is how a deployment ends up with wrong assumptions.

---

## The relaxation schedule change you asked for

Now **0s · 90s · 3m · 6m** inside the unchanged 15-minute deadline, replacing 0/4/8/12 minutes.

Configuration-driven three ways: a default in the ladder, `RELAXATION_SCHEDULE_SECONDS` in the
environment, and the seeded `PlatformConfiguration` record — and it snapshots onto every
`MatchingRun`, so retuning it never rewrites the reasoning behind an old decision.

The unit changed from minutes to **seconds**, because 90 seconds is not a whole number of minutes and
a unit that cannot express the configured value is the wrong unit.

Validated at boot: four ascending values, the first must be 0, and the last must land well inside the
matching window — a rung nothing can ever stand on is a rung that lies about the ladder.

**The floor is untouched.** Every level's primary floor still passes through `floorForLevel`, and a
test asserts across all four levels that a faster schedule widens _sooner_ and never _further_.

---

## Gate results

```
── verify ──                                  ── e2e (real HTTP) ──
  ✓ format                                          phase2:  41 passed, 0 failed
  ✓ lint                                            phase3:  27 passed, 0 failed
  ✓ typecheck                                       phase4:  61 passed, 0 failed
  ✓ test                                            phase5:  64 passed, 0 failed
  ✓ local postgres available                        phase6:  41 passed, 0 failed
  ✓ migrations apply to a fresh database
  ✓ dev database is migrated and seeded
  ✓ web builds
  ✓ worker boots
```

| Gate requirement | Result                                                            |
| ---------------- | ----------------------------------------------------------------- |
| Tests            | **459 passing** (was 428) — 403 domain, 36 contracts, 20 adapters |
| New this phase   | 20 realtime-contract tests, 11 schedule/env tests, 41 HTTP checks |
| Lint             | Clean, 7 packages, 0 errors                                       |
| TypeScript       | `tsc --noEmit` clean, `strict` + `noUncheckedIndexedAccess`       |
| Migrations       | None — realtime adds no tables. Postgres `NOTIFY` needs no schema |
| Build / boot     | Web builds 45 routes; worker runs 4 handlers + 3 janitors         |

**Exit criterion met:** the §38 flow, live in two browsers — _"I need Apex help"_ → classified →
ranked → offered on the correct expert's screen with sound and notification → accepted → customer
sees Expert Found, with the admin able to intervene at any point.

---

## Your eighteen requirements, as built

### 1–3 — Realtime is a doorbell, not a delivery

The single decision the whole phase rests on: **a signal carries a type and a timestamp, and nothing
else.** `{"type":"offer.opened"}`. The client's only possible response is to re-fetch from an
authenticated endpoint.

That satisfies three requirements structurally rather than by discipline:

- **1 — never the source of truth.** There is no state in the message to mistake for truth.
- **2 — idempotent.** Replaying "something changed" re-runs a GET. Twice and once are the same.
- **3 — reconcile, don't trust.** Not a rule the client is asked to follow; there is nothing else it
  _could_ do.

The client hook is called `useRealtime(reconcile)` and never hands its caller a payload, because the
endpoint never sends one. A component written against it cannot trust an event as state.

Asserted directly: every published event's `payload` must equal `{}`, and the serialised wire must not
contain `score`, `rank`, `finalScore`, another expert's id, `exclusion`, or `breakdown`.

### 4 — Offers appear without a refresh

Measured: **~390ms** from the customer pressing submit to the signal being published (313ms to the
offer row committing, 76ms to the publish). The expert's browser then fetches and renders. The e2e
watches a real SSE stream and asserts the signal arrives.

### 5 — Customer status is live through every transition

`SEARCHING → OFFERED → ACCEPTED`, and both alternative endings. Including the case that is easy to
miss: `beginSearch` signals **before any offer exists**, so a search spending its first 90 seconds
waiting for the relaxation schedule looks different from one that has stalled.

### 6 — Permission only after an explicit action

`requestNotificationPermission` is called from exactly one place: the **Enable notifications** button.
Never on mount, never on login, never on any path an expert did not choose.

That is not only compliance with the requirement, it is the only approach that works. A denial cannot
be re-requested in-app — the expert has to go into browser settings, which most never will — so the
one chance to ask is spent when they have just pressed a button asking for it. When permission _is_
denied, the UI says so plainly instead of offering a button that cannot work.

### 7 — Notification content is minimal

> **New Salesforce support request**
> Apex · Apex Triggers · Governor Limits — open to review.

Skills and nothing else. No customer text, no title derived from their description, no request id.
A notification is rendered by the OS, may sit on a lock screen, may be read aloud by an assistant,
and may be seen by whoever is near the machine — it has to be safe in all of those places, and a
customer's problem description frequently is not. The e2e asserts the customer's words never reach
the wire at all.

### 8 — Sound, with a persisted mute and autoplay handled

Synthesised with the Web Audio API — two sine notes a fifth apart. No asset to ship, nothing for the
CSP to allow, nothing to 404, works offline.

Autoplay is handled by not fighting it: browsers refuse audio until the page has been interacted
with, so rather than trying silently and failing silently, the expert presses **Enable sound**, hears
the tone, and knows it works. After that, **Mute**/**Unmute** persists in `localStorage`.

Per-device deliberately. Sound on the desktop and silence on the laptop is a coherent preference that
a server-side setting could not express.

### 9 — Email is awareness, never delivery

No email is on the critical path and nothing waits for one. Both messages are written to be **true
when read late**: _"You missed a Salesforce request"_, past tense, because _"a request is waiting for
you"_ would be a lie by the time most people read it. Neither contains the customer's description —
same reasoning as the notification, with more permanence.

`ConsoleMailer` is the default until a provider is chosen, and it logs rather than silently
discarding, so the walkthrough can show that email happened without an API key.

### 10 — Notification failure never affects dispatch

Enforced three ways, in increasing strength:

1. `DispatchNotifier` swallows every failure and is incapable of throwing at a caller.
2. Notification happens strictly **after** the durable write commits.
3. The notifier is **optional**. There is a test that removes it entirely and asserts the Phase 5
   behaviour is unchanged, and another that has the provider actively throwing on every publish while
   an offer is created, expires, is declined, and is accepted.

`REALTIME_PROVIDER=mock` is that configuration, runnable. Every offer still arrives, still expires on
time, still accepts — only the immediacy is lost.

### 11 — Realtime authorization

**The client never names a channel.** It opens `/api/v1/realtime` and the _server_ decides what it
will receive, computed from the session: `expert:<own profile id>` and `customer:<own profile id>`.

Requirement 11 is satisfied by removing the attack surface rather than guarding it — there is no
channel parameter to tamper with, no token to forge, no subscribe message to craft. An expert cannot
ask for another expert's channel because asking is not part of the protocol.

Both channels are derived from **identity**, and that was a correction: see finding 3 below.

### 12 — Nothing sensitive on the wire

Covered under 1–3. The e2e greps a real captured stream for the customer's problem text, scores,
ranks, exclusion reasons, the other expert's id, and even the request id — none appear.

### 13 — Accept/decline stays an ordinary server operation

`POST /api/v1/expert/offer` with a session cookie, exactly as in Phase 5. The realtime stream is
one-directional by choice — SSE rather than a WebSocket — so there is no channel through which a
client could attempt to accept, and acceptance cannot depend on a client-side event because the
server does not read one.

### 14 — Reconnect reconciles

`reconcile` runs on signal, on connect, and on **re-connect**. Because reconnecting triggers a fetch
rather than a replay, an expert who was offline while their offer expired comes back to _"That one has
gone"_ — never to a card they can still click. The e2e does this literally: kills the stream, waits
out the window, reconnects, and asserts the offer is gone and accepting it is refused.

### 15 — The window is never reset by delivery

`offerExpiresAt` is a stored column; the countdown is a subtraction from an absolute instant. A test
publishes five signals mid-offer and asserts the stored deadline is unchanged.

### 16 — Timing instrumentation

All eight points, one greppable format: `latency <point>`.

```
request_submitted · classification_completed · matching_run_started
offer_persisted · realtime_published · expert_reconciled
expert_accepted · customer_reconciled
```

The first six are server-side. The last two are reported by the browser to
`POST /api/v1/telemetry/timing`, because only the client knows when a human could actually _see_
something — and that gap (network, SSE hop, fetch, render) is exactly what the assessment is about.
The endpoint accepts an enum of two points and a bounded number, so a client cannot write arbitrary
strings into our logs.

### 17 and 18 — At the top of this document.

---

# MVP Assessment

The formal assessment you asked for before Phase 7.

## Measured latency

From the timing instrumentation, on this machine with the rules classifier and a ~20-expert seeded
database:

| Segment                          | Median           | Notes                                                       |
| -------------------------------- | ---------------- | ----------------------------------------------------------- |
| submit → classification complete | **175–290 ms**   | The classifier itself is 14–95 ms. The rest is the job hop. |
| → matching run started           | **313 ms**       | Ranks ~21 candidates.                                       |
| → offer row committed            | **313 ms**       | Ranking and persistence are not measurably separable.       |
| → realtime signal published      | **+26–76 ms**    |                                                             |
| **submit → doorbell rung**       | **≈ 340–390 ms** |                                                             |
| expert's observed response time  | **3 s**          | Human, not system.                                          |

**The system is not the bottleneck, and it is not close.** Under 400 ms server-side, of which the
classifier is a quarter. When perceived latency is bad it will be the browser, the network, or a
human — and the instrumentation now distinguishes those, which was the point.

Two caveats before this becomes a claim: the AI classifier is `mock` (the rules engine), so a real
Haiku call adds a network round-trip — budget 400–900 ms, taking the total to roughly **1.5 s**,
still comfortable. And this is localhost, so the SSE hop is free; over the internet add a round-trip.

## Does the 60-second offer window feel right?

**Yes, with one reservation.** It felt long in testing rather than short — I was waiting for it, not
racing it. Three seconds was a comfortable, unhurried response.

The reservation is that I tested it with the tab visible and the sound enabled. The window is only
long enough _if the expert notices_, and this phase's notification story is foreground-only: no
service worker, so nothing reaches an expert whose tab is closed. For a launch roster on scheduled
on-call shifts (Q14) that is probably acceptable, because being on shift means having the tab open.
It stops being acceptable the moment experts are opportunistic rather than rostered.

**Recommendation:** keep 60 seconds. Add the service worker before opening to non-rostered experts,
and watch `expert_accepted.responseSeconds` — if the median creeps past ~20 seconds, the window is
doing work it should not have to.

**Settled:** 60 seconds stays for production. The service worker stays deferred, on the basis that the
launch bench is rostered and explicitly available — experts are expected to keep the dashboard open
while marked available, which is exactly the case the foreground-only design covers. That assumption
is worth revisiting the first time an expert is opportunistic rather than on shift.

## Does the relaxation schedule feel right on a launch-sized roster?

**The new schedule is a clear improvement, and one thing underneath it is wrong.** This is the most
important finding in the phase.

**Finding 1 — secondary-skill coverage as a level-0 filter costs three minutes.**

Observed in the e2e, with real numbers. A request classified as `apex` (primary) + `batch-apex`
(secondary) went to an expert who had declared `apex: ADVANCED` and `triggers: ADVANCED` — a
genuinely well-qualified person for a batch Apex problem. They were **excluded at level 0** with
`INSUFFICIENT_SECONDARY_COVERAGE`, excluded again at level 1, and only admitted at **level 2 — 180
seconds later**. The measured `offer_persisted` for that request was `sinceSubmittedMs: 180541`.

Three minutes of a fifteen-minute promise, spent not offering work to someone who could have done it,
because the taxonomy is finer-grained than expertise is. On a roster of 10–20 experts this will not be
rare — it will be most requests where the classifier names a supporting skill the expert happened not
to list.

Phase 5 already lowered this from 1.0 to 0.25 after the same class of failure. The pattern is now
clear enough to name: **secondary coverage should not be a hard filter at any level.** It is already
in `skillScore`, where a candidate covering more supporting skills ranks higher — which is the correct
mechanism. Keeping it as a filter as well double-counts it and lets the filter, rather than the score,
decide.

**Applied, with your approval.** `secondaryCoverage` is 0 at every level. The signal moved entirely
into `skillScore`, where a candidate covering more supporting skills still ranks higher and one
covering none still ranks lower — that half was explicitly retained and is now asserted by its own
test. The primary-skill floor and the banded ranking are untouched.

The field is kept at 0 rather than deleted so the lever and its history stay legible, and a test
asserts it is 0 on every rung — so re-enabling it means changing a test and reading why it is there.

Worth naming the pattern, because it happened twice: a _supporting_ signal was promoted to a **hard
gate**, and both times it excluded exactly the right person. Filters answer "could this person do
this at all"; everything else belongs in the score.

**Finding 2 — with that fixed, 0/90s/3m/6m looks right.** The remaining reasons to relax are now
genuinely about competence and rating: level 1 drops the rating floor, level 2 lowers the primary
floor to its absolute minimum and drops the language preference, level 3 lets a category sibling
stand in when scoring. Reaching maximum relaxation at 6 minutes leaves 9 to find someone, which is
the right shape for a thin bench.

## Do the ranking choices look sensible?

**Yes on the data available, and two of five components are currently inert.**

The choices I watched were the ones I would have made: the EXPERT-level Apex specialist beat the
ADVANCED one; the generalist with BEGINNER Apex was never offered anything; the §14 fairness case
resolves toward the expert who has been waiting. The banded ranking you approved is doing visible
work — the audit page shows band 3 above band 2 regardless of the weighted score.

But **`ratingScore` and `reliabilityScore` are effectively constants today.** No sessions have
completed, so every expert sits at the 4.5 rating prior, and `avgResponseSeconds` is never written so
the speed term is a flat 0.5 for everyone. The ranking is really skill + experience + fairness right
now. That is fine — and it means _nobody should draw conclusions about the weights until Phase 9 has
put real ratings in_. Worth saying explicitly because the weights look tuned and are not yet tested.

## The biggest remaining blockers to real users

In the order I would fix them.

1. **No money.** `MockPaymentGateway` authorizes nothing. A customer is never charged, an expert is
   never paid, and `NO_EXPERT_FOUND` does not void an authorization that does not exist. Phase 7a/7b,
   and 7b is still blocked on **Q3** — the entity and geography decision. This is the single largest
   gap and it is a business decision, not an engineering one.
2. **No session.** An expert accepts and the loop ends. There is no room, no call, no way to actually
   deliver the help that was just sold. Phase 8.
3. **Supply, not software (Q14).** The matching engine is provably correct and cannot match against
   an empty bench. Ten to twenty hand-recruited experts on scheduled shifts is still the top risk to
   the product, and nothing in Phases 1–6 has reduced it.
4. **Rate limiting is per-process (G1).** `InMemoryRateLimiter` gives no protection behind more than
   one instance. `/api/v1/expert/heartbeat` and the SSE endpoint are the new high-frequency routes.
5. **Attachment storage is local disk (G2).** Does not survive a redeploy.
6. **No service worker.** Notifications are foreground-only. Accepted for launch: the bench is
   rostered and expected to keep the dashboard open while available. It becomes a blocker the moment
   experts are opportunistic rather than on shift.
7. **Realtime needs a stateful process.** A serverless web tier cannot hold `LISTEN`. Either deploy
   to a container or write the hosted adapter.
8. **Pricing is placeholder (Q2).** ₹1,000 / ₹1,800 are deliberately obvious round numbers.

**My overall read:** the part that was hardest to get right — matching, dispatch, presence, the
timers, the audit trail — is done and is measurably fast. What stands between this and real users is
almost entirely _unbuilt_ rather than _wrong_: money, a session, and experts. The one thing I would
change about what exists is finding 1.

---

## Notable engineering

**Postgres `LISTEN`/`NOTIFY` instead of a hosted service.** No signup, no API key, and no second
failure domain — the whole loop is demonstrable by anyone who can run the app. It is a defensible V1
choice _because_ realtime is not the source of truth: a modest transport is acceptable when a dropped
message costs latency and nothing else. The `RealtimeBus` port keeps a hosted provider a
composition-root change.

**One `LISTEN` connection per process, fanned out in memory.** A connection per SSE subscriber would
exhaust the pool at a few dozen experts.

**One Postgres channel, filtered server-side.** Per-expert `LISTEN` names are 63-byte identifiers and
cannot be un-listened cleanly. One channel plus filtering where authorization already lives is
simpler _and_ safer.

**`REALTIME_PROVIDER=ably` throws at boot.** Someone who sets it expects a hosted provider; quietly
giving them something else is how a deployment acquires wrong assumptions.

**Timing lines share one format from one function.** The eight points span three modules, and a
format defined in three places cannot be grepped.

**The telemetry endpoint is narrow on purpose.** An enum of two points and a bounded integer, actor
from the session. A client cannot write arbitrary strings into our logs or report timing for anyone
else.

---

## Three things testing changed

**Finding 3 — the customer's channel set went stale, and the e2e caught it.**

The SSE endpoint originally computed the allowed channels as `request:<id>` for each of the customer's
requests, read once at connect. The Phase 6 e2e failed on _"the customer's stream learned the state
changed"_ — because the request was created **after** the stream opened, so its channel was never in
the set.

Not a test artefact. Next.js App Router navigates client-side, so a customer who opens the dashboard
and then submits a request keeps one long-lived stream — and would sit watching a spinner while their
request was already matched and offered.

Fixed by keying the channel on **identity** rather than on a list of rows: `customer:<profileId>` is
computable once from the session and stays true. The general lesson is worth keeping: an authorization
set derived from mutable rows is only correct at the instant it is computed, and a long-lived
connection outlives that instant.

**Finding 4 — an under-specified fixture looked like a realtime bug.** The second scenario's expert
had `apex` + `triggers` but the classifier asked for `apex` + `batch-apex`, so they were filtered out
on coverage and the offer took 180 seconds — well past the test's timeout. It presented as "realtime
did not deliver". It was finding 1, wearing a disguise. Both the fixture and the assessment now say so.

**Finding 6 — `pnpm verify` was running the tests before starting the database.**

Found while re-running the gate after the secondary-coverage change, with Postgres
happening not to be up. The `test` step sat with the other static checks, _before_
the step that starts the embedded server — so the Phase 5 concurrency suite, the
one that needs a real database because a partial unique index cannot be tested any
other way, failed outright.

It had been passing for two phases purely because the server was always already
running from a previous `pnpm dev`. Worse, before Phase 5 made the adapters test
load `.env`, the same suite _skipped silently_ inside verify — a gate omitting its
most important assertion reads exactly like a gate that passed.

`test` now runs after Postgres is confirmed up. `--quick`, which explicitly
promises static checks and no database, sets `SKIP_DB_TESTS=1` and labels itself
`test (no database — DB-backed suites excluded)` so the exclusion is visible in
the output rather than inferred from a count. The full run reports 20/20 in
adapters, where it previously reported 13 passed and 7 skipped.

**Finding 5 — `z.NEVER` is an object, not a value.** The `RELAXATION_SCHEDULE_SECONDS` transform
rejects a bad schedule, but the object-level `superRefine` still runs, and reading `.at(-1)` on Zod's
`INVALID` sentinel threw a `TypeError` — so a misconfigured deployment got an unreadable stack trace
instead of the message naming what was wrong. Guarded with `Array.isArray`.

---

## Significant files

**New — domain**

`matching/dispatch-events.ts` — `DISPATCH_EVENTS`, `TIMING_POINTS`, `DispatchNotifier`, `logTiming`.
The module comment is where the "doorbell, not delivery" decision is recorded.
`matching/realtime.test.ts` — 20 tests on the contract.

**New — adapters**

`realtime/postgres-realtime-bus.ts` — `PostgresRealtimeBus`, `PostgresRealtimeHub`,
`NoopRealtimeBus`.
`notifications/console-mailer.ts` — the mailer and the two awareness emails.

**New — web**

`app/api/v1/realtime/route.ts` — the SSE stream, and where requirement 11 lives.
`app/api/v1/telemetry/timing/route.ts` — the two client timing points.
`lib/use-realtime.ts` — `useRealtime(reconcile)` and `reportTiming`.
`lib/offer-alerts.ts` — synthesised tone, mute preference, notification opt-in and content.
`components/expert/alert-settings.tsx` — the two opt-in buttons.

**Modified**

`matching/relaxation.ts` (seconds, the new schedule, `engagesAtSeconds`) ·
`matching/matching-service.ts` (notifier at every state change, configurable schedule) ·
`ports/realtime.ts` (+`customer` channel) · `support-requests/request-service.ts` (+timing) ·
`classification/classify-request.ts` (+timing) · `offer-panel.tsx` and `request-status.tsx`
(polling → realtime) · both containers · `env.ts` · `turbo.json` · `.env.example`

---

## Assumptions

1. **A signal never carries state.** Everything in requirements 1–3, 12 and 15 follows from it, so it
   is the one thing not to relax later for a latency win.
2. **The mute preference is per device.** A coherent preference a server-side setting could not
   express.
3. **The fallback poll is 15 seconds.** Slow enough to be a safety net rather than a mechanism.
4. **The SSE keep-alive is 25 seconds**, under the usual 30-second proxy idle timeout.
5. **Notifications are foreground-only.** No service worker in V1.
6. **The customer's stream covers their own channel only** — one in-flight request at a time makes
   that sufficient.
7. **Timing goes to logs, not a metrics store.** Right for an assessment on seeded data; Phase 11
   wants real aggregation.

---

## Deviations from the approved architecture

**One.** §17 named **Ably**; this ships **Postgres `LISTEN`/`NOTIFY`**. The port is unchanged and a
hosted adapter is a composition-root change. Recorded in `ARCHITECTURE.md`.

Reasoning: realtime is explicitly not the source of truth, which makes the transport a cost/benefit
call rather than a correctness one. Postgres wins on setup (none), on failure domains (none new), and
on being demonstrable by anyone who can run the app. It loses on serverless deployment, which is a
real cost and is written down above rather than discovered later.

**Approved for the MVP**, with the `RealtimeBus` abstraction preserved so a hosted provider stays a
composition-root change if the production topology needs one. Nothing outside
`apps/web/lib/container.ts`, `apps/worker/src/container.ts` and one adapter file knows which transport
is in use — `MatchingService` takes a `DispatchNotifier`, which takes a `RealtimeBus`, and neither has
a Postgres-shaped assumption in it.

---

## Remaining TODOs

- **G1 rate limiting** — shared store. `heartbeat` and the SSE endpoint are new candidates.
- **G2 storage** · **G3 CSP** · **G4 Sentry** — unchanged. CSP now needs to permit `text/event-stream`.
- **Service worker** for background notifications. Deferred by decision, not by oversight — see the
  assessment. Required before experts can be opportunistic rather than rostered.
- **Hosted realtime adapter** if the web tier goes serverless.
- **`avgResponseSeconds` is never written**, so the reliability speed term is inert. Phase 9.
- **Ratings are all zero**, so `ratingScore` is the prior for everyone. Phase 9.
- **The offer-missed email is written but not sent** — no job enqueues it. One handler in Phase 7.
- **The candidate query has not been load-tested.** Phase 11.
- **Account deletion is still blocked by attachments** (Phase 3 finding).
- **Q2 pricing** · **Q3 payout geography** · **Q14 supply** — all still open, and Q3 blocks 7b.
