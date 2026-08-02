# Phase 3 — Support Requests · Gate Summary

**Status:** Complete. `pnpm verify` 9/9, `pnpm e2e:phase3` 27/27. Stopped before Phase 4.
**Date:** 2026-08-02
**Checkpoints:** Phase 1 `6abcd51`, Phase 2 `5cb8c4e`. Phase 3 uncommitted, awaiting approval.

---

## 👀 Visual review — what to click through

The dev server is running. Open **http://localhost:3000**.

If it isn't running: `pnpm pg:start` in one terminal, `pnpm dev` in another.

### Setup (one minute)

Register at `/register` with any email and a **12+ character password**. That account is your
customer. Nothing is seeded — no demo credentials exist by design.

### Flow 1 — The lightweight path (the one that matters)

This is requirements 1–3 made concrete. **Time yourself.**

1. `/dashboard` → **Get Expert Help**
2. Type only a description. Something real:
   > *Our Apex trigger on Account hits "Too many SOQL queries: 101" when we bulk load about 4000 records. The trigger looks bulkified to me but it still dies around record 3800.*
3. Press **Get Expert Help**

**What to look for:**

- One textarea and one button. No category picker, no skill checkboxes, no title field, nothing
  required beyond the description. That is the whole form until you ask for more.
- You never wrote a title — the status page has one, taken from your first sentence.
- Within a few seconds the status moves **Reading your problem → Finding the right Salesforce
  expert…**, and a *"What we think this is about"* panel appears with `Apex`, `Triggers`,
  `Governor Limits` and difficulty **advanced**. You told it none of that.
- The credential line under the textarea: one calm sentence, grey, no icon, no red. Judge whether
  it reads as guidance rather than a warning label.

### Flow 2 — Optional detail (requirement 3)

Cancel the request, then start another and click **+ Add detail (optional)**.

- Category chips appear with *"Only if you already know — we work it out from your description
  either way, and guessing wrong costs you nothing."* Read that line and tell me if it lands.
- Pick a category → specific skills appear for it. Pick none and the form still submits.
- **Choose files** — attach a `.log` or screenshot. It uploads immediately, so submitting is
  instant rather than waiting on the file.

### Flow 3 — The credential warning (requirement 5)

Start a request and paste something that *looks* like a leak:

```
Callout to our REST endpoint fails.
Sid=00D5f000000abcdE!AQcAQH0dMHZfz.SsBcMxYo8mVXJ4Kz9pQrStUvWxYz01
and the named credential has password=hunter2please
```

**What to look for:**

- The request still submits. It is not blocked, and there is no modal.
- On the status page, *"What you told us"* shows the session ID and password replaced with
  `[SALESFORCE_SESSION_ID_REMOVED]` and `password=[REMOVED]` — but the sentence around them is
  intact and still readable.
- The message says *"…removed it before saving. Nothing was shared."* Judge the tone: it should
  read as helpful, not as an accusation. This is the balance you asked for and the part I would
  most like your eye on.

### Flow 4 — Classifier failure (requirement 4)

Describe something with no recognisable Salesforce vocabulary:

> *Everything is broken and nobody on my team knows what changed since yesterday afternoon.*

The classifier finds nothing and returns null. **The request still reaches "Finding the right
Salesforce expert…"** — it just has less to go on. That is requirement 4: classification is an
accelerator, never a gate.

### Flow 5 — Cancel

From any in-flight request, **Cancel request** → *"Your payment authorization has been released.
Nothing was charged."* The dashboard returns to the **Get Expert Help** card.

### Also worth a look

- `/requests` — history, with state badges.
- `/dashboard` — the Get Expert Help card becomes a live-status card while a request is in flight.
- Expert and admin flows from Phase 2 are unchanged and still work.

### Known rough edges (already on my list)

- Cancelled requests keep their attachments; there is no delete-attachment UI yet.
- The status page polls every 3 seconds. Phase 6 replaces that with realtime.
- Pricing shows the placeholder ₹1,000 / ₹1,800 tiers — Q2 is still open.

---

## Gate results

```
── verify ──                                  ── e2e (real HTTP) ──
  ✓ format                                1.9s    phase2: 41 passed, 0 failed
  ✓ lint                                  0.6s    phase3: 27 passed, 0 failed
  ✓ typecheck                             0.6s
  ✓ test                                  0.6s
  ✓ local postgres available              0.1s
  ✓ migrations apply to a fresh database   5.0s
  ✓ dev database is migrated and seeded    4.1s
  ✓ web builds                            16.6s
  ✓ worker boots                           1.8s
```

| Gate requirement | Result |
| --- | --- |
| Tests | **171 passing** (was 116) — 151 domain, 13 adapters, 7 contracts |
| Lint | Clean, 7 packages, zero warnings |
| TypeScript | `tsc --noEmit` clean, `strict` + `noUncheckedIndexedAccess` |
| Fresh migrations | 3 migrations → throwaway database, 28 tables, 5 partial indexes asserted |
| Build / boot | Web builds 22 routes; worker registers 6 queues **and now runs the classify handler** |

**Exit criterion met:** a customer submits a request with attachments, it reaches `SEARCHING`, and
the state history is written — verified over HTTP with real cookies.

---

## Your nine requirements, as built

### 1 & 3 — Lightweight, description-first, fast to submit

The form is one textarea and one button. `title` is derived from the first sentence server-side, so
nobody composes a subject line. Category, skills, attachments and duration all sit behind
**+ Add detail (optional)**, and every one of them is genuinely optional — the e2e submits with a
description and a tier and nothing else.

Attachments upload the moment they are chosen, so pressing submit is never blocked on a 10 MB file.

### 2 — Selections assist; they never make the customer the diagnostician

Three things enforce this rather than just saying it:

- The picker's own copy: *"Only if you already know — we work it out from your description either
  way, and guessing wrong costs you nothing."*
- **A customer-selected skill is never stored as `isPrimary`.** Primary drives the hard competence
  filter in Phase 5, and that judgement belongs to the classifier and the description, not to the
  person with the problem. Asserted in both unit and HTTP tests.
- An unknown slug is ignored, not rejected. A stale bookmark cannot fail someone's request.

Both sources are kept side by side (`CUSTOMER_SELECTED` / `AI_DETECTED`), which is what lets us
measure the classifier against real customer input later.

### 4 — Classification is non-blocking, with the customer's input as fallback

`ClassificationService` reaches `SEARCHING` on **every** path. Six tests cover the ways it can fail:
returns null, throws, hangs past its budget, returns a hallucinated slug, has no customer selections
to fall back on, and gets redelivered. The failure reason is recorded on the row so a spike is
measurable rather than invisible.

A recovery sweep in the worker picks up anything stranded in `CLASSIFYING` for over a minute. The
enqueue is transactional so it shouldn't happen — but "shouldn't happen" is a poor thing for a
paying customer's request to depend on, and a stuck request never resolves and never refunds itself.

### 5 — Prominent but not frightening

One grey line under the textarea, always present, no icon. It explains and reassures rather than
warning. When something *is* detected, the message is specific and calm:

> *We spotted what looks like a Salesforce session ID in your description and removed it before
> saving. Nothing was shared. Please avoid pasting credentials or production data — an expert never
> needs them to help you.*

A test asserts the message contains none of "violation", "forbidden", "breach", "danger", "illegal".
The request is never blocked and there is no modal.

### 6 — Nothing reaches the classifier before redaction

Enforced by ordering in `SupportRequestService.create`: scan and redact happen **before** the row is
written, so the raw text is never persisted at all. The classifier reads from the stored row, which
is already clean, and re-scans anyway — cheap belt-and-braces so a future code path that stores raw
text cannot silently start leaking through it.

**Attachment contents are never sent to the classifier.** It receives title and description only.

The HTTP test posts a session ID and a password, then re-fetches the row and confirms neither is
present while the surrounding sentence survives.

### 7 — Attachments stay private

Three independent gates on download: a valid HMAC signature, an authenticated session, and ownership
re-derived from the database. A forged signature gets 403; another customer gets `FORBIDDEN`; both
are tested over HTTP.

Storage keys are generated server-side and never contain the customer's filename, which removes
filename-driven path traversal rather than sanitising it. Downloads are always
`Content-Disposition: attachment` with `nosniff`, so an SVG or HTML upload cannot execute in our
origin. Binding an attachment to a request is scoped to the uploader and to still-unbound rows.

### 8 — Rate limiting promoted to a pre-deployment gate

Recorded in [ARCHITECTURE.md → §9a Pre-deployment gates](ARCHITECTURE.md) as **G1**, alongside four
others it turned out to belong with (object storage, CSP, Sentry, `embedded-postgres`).

Wired now, at the call sites: auth, request creation (5 per 5 min), attachment upload (20 per
5 min). The e2e proves the limiter actually trips. The backing store is the outstanding part — the
in-memory limiter is per-process, so N instances give an attacker N× the limit and a deploy resets
every counter.

One thing that surfaced while wiring it: the unauthenticated limit keys on `x-forwarded-for`, which
is trustworthy on Vercel and spoofable on a platform that doesn't strip inbound copies. Noted in the
gate entry.

### 9 — Visual review section

At the top of this document.

---

## Notable engineering

**A rules-based classifier, not a stub.** `RulesProblemClassifier` scores the description against
the skill aliases already in the database. It exists for two reasons: local development and CI need
the whole flow to work without an API key (a stub returning null would exercise only the failure
path), and it is the baseline the model has to beat — a model that can't outperform keyword matching
isn't worth its latency. It improves as the taxonomy does, with no code change.

**The real Claude classifier is written and wired**, defaulting to `claude-haiku-4-5`. The skill
enum in its JSON schema is generated per request from the active Skill table, so a hallucinated
skill is structurally impossible rather than filtered out afterwards. The taxonomy sits in a
cache-controlled system prompt with the volatile problem text last. It logs a warning if that prompt
falls below Haiku 4.5's 4096-token cache minimum, because below that the cache is silently ignored
and every call pays full price. Set `CLASSIFIER_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` to use it.

**Price comes from the tier row, never the request body.** A client that posts its own amount
changes nothing.

**Local storage that keeps its shape.** `LocalFileStorage` implements the same presign/verify
interface R2 will, including signed expiring URLs, constant-time signature comparison, and
separator-aware path containment. Swapping in R2 is a change in the composition root.

---

## Three bugs the tests caught

**1. The scanner wasn't idempotent.** `password=[REMOVED]` re-matched the assigned-secret pattern, so
rescanning already-clean text produced a fresh finding — meaning a customer could be warned about
text we had cleaned ourselves. Fixed with a negative lookahead for our own placeholders.

**2. My own lint rule was too blunt.** The money rule flagged every `Math.round`, including
`bytes / 1024` and `ms / 1000`. A rule with false positives gets disabled wholesale and then
protects nothing, so I narrowed it to the actual mistake — rounding a value divided by 100, which is
minor-units-to-major and loses the remainder.

**3. A stale server invalidated an entire e2e run.** The first Phase 3 e2e reported 11 failures that
were all one cause: a `next start` from Phase 2 still held port 3000, so `pnpm dev` never bound and
the tests hit an old build. Worth stating plainly because I nearly debugged the wrong thing — the
symptom was "Internal Server Error" from routes that were fine.

---

## Significant files

**New — domain**

| File | Why |
| --- | --- |
| `security/secret-scanner.ts` | 9 patterns, redaction, calm messaging (27 tests) |
| `support-requests/request-service.ts` | redact → price → authorize → persist → CLASSIFYING |
| `classification/classification-service.ts` | always reaches SEARCHING, six failure paths tested |
| `ports/rate-limiter.ts` | `RateLimiter` + the named budgets |
| `ports/request-repositories.ts` | request, taxonomy, pricing, attachment, scheduler ports |
| `support-requests/in-memory-request-world.ts` | faithful fakes incl. optimistic version checks |

**New — adapters**

`classification/rules-classifier.ts` · `classification/anthropic-classifier.ts` ·
`persistence/prisma-request-repositories.ts` · `storage/local-storage.ts` ·
`ratelimit/in-memory-rate-limiter.ts` · `jobs/pgboss-scheduler.ts` · `jobs/send-only-boss.ts`

**New — web (8 routes, 5 pages)**

API: `v1/requests` (GET/POST) · `v1/requests/[id]` · `v1/requests/[id]/cancel` · `v1/taxonomy` ·
`v1/attachments` · `v1/attachments/upload` · `v1/attachments/download`
Pages: `request-help` · `request/[id]` · `requests` · updated `dashboard`
Components: `request-form` · `attachment-picker` · `request-status`
Lib: `queues` · `rate-limit` · `request-view`

**New — worker**

`container.ts` · `jobs/classify-request.ts` (handler + recovery sweep) · handler registration

**New — tests (55 added)**

`secret-scanner.test.ts` (27) · `request-lifecycle.test.ts` (28) ·
`scripts/e2e/phase3-requests.sh` (27 HTTP checks)

**Modified**

`policy.ts` (+4 request permissions) · `actor.ts` (+`customerProfileId`) · `session.ts` ·
`container.ts` (Phase 3 services) · `base.mjs` (narrowed money rule) · `ARCHITECTURE.md` (§9a) ·
`worker/src/index.ts`

---

## Assumptions

1. **One in-flight request per customer.** Two would compete for the same experts and hold two
   authorizations. Enforced in the service; the form redirects to the live request.
2. **Attachments are bound at submit, not at upload.** Lets someone attach a screenshot before
   finishing the description. Orphans are possible if they abandon the form — a cleanup job is
   Phase 11.
3. **The status page polls at 3s.** Replaced by realtime in Phase 6; it stops on terminal states.
4. **No AV scanning on uploads.** Extension + MIME + magic-byte allowlist and size caps only. Real
   scanning is a Phase 11 decision.
5. **`text/xml` and `application/xml` accepted** but never parsed by us — stored and served as
   opaque bytes, so XXE is not reachable.
6. **The customer sees the redacted text**, not the original. There is no "show original", because
   we never keep one.

---

## Deviations from the approved architecture

**None.** Two additions worth recording:

- **A recovery sweep in the worker** for requests stranded in `CLASSIFYING`. §17 rules out polling
  for *dispatch*; this is a janitor on a 30-second cadence, and without it a lost enqueue leaves a
  paid request invisible forever.
- **The web app runs a send-only pg-boss client.** It enqueues but registers no handlers, so the
  dispatch loop stays entirely in the worker per D2.

---

## Remaining TODOs

- **G1 rate limiting** — shared store before public deploy.
- **G2 storage** — R2 before public deploy; local disk doesn't survive a redeploy.
- **Sentry, CSP** — unchanged (G3, G4).
- **Account deletion is currently blocked by attachments.** `Attachment.uploadedByUserId` is
  `onDelete: Restrict`, so deleting a user with uploads fails. Correct for now, but whoever writes
  the GDPR-deletion flow needs to handle attachments explicitly. Found while cleaning up test data.
- **Orphaned attachment cleanup** — uploads from abandoned forms are never collected.
- **Q2 (pricing numbers)** — the placeholder tiers are now visible in the UI.
- **Email verification / Mailer** — still deferred; slipped from Phase 3 as nothing in this phase
  sends email.

---

## Phase 4 scope, for reference

Expert dashboard, the availability toggle, heartbeat plus the sweep job, availability history, and
expert skill management.

Exit criterion: closing the tab marks the expert offline within 3 minutes, and the API is
mobile-shaped.

Awaiting your review.
