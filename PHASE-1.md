# Phase 1 — Foundation · Gate Summary

**Status:** Complete. `pnpm verify` green, 9/9 steps. Awaiting approval for Phase 2.
**Date:** 2026-08-02

---

## Gate results

```
── verify ──
  ✓ format                                1.3s
  ✓ lint                                  0.8s
  ✓ typecheck                             0.7s
  ✓ test                                  0.7s
  ✓ local postgres available              0.1s
  ✓ migrations apply to a fresh database  4.8s
  ✓ dev database is migrated and seeded   4.1s
  ✓ web builds                           12.8s
  ✓ worker boots                          1.3s

all 9 steps passed
```

| Gate requirement    | Result                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| Tests               | **55 passing** — 35 domain, 13 adapters, 7 contracts                                                       |
| Lint                | Clean, 7 packages, zero warnings                                                                           |
| TypeScript          | `tsc --noEmit` clean, 7 packages, `strict` + `noUncheckedIndexedAccess`                                    |
| Migrations verified | 2 migrations apply to a **fresh** database → 28 tables, 5 partial indexes asserted                         |
| App starts          | Web served `/`, `/api/v1/health` → `200 {"status":"ok"}`, worker registered 6 queues and shut down cleanly |

Beyond the gate, verified by hand against the running app:

- `GET /api/v1/health` → `{"status":"ok","checks":{"database":{"ok":true},"providers":{"ok":true,"detail":"payment=mock payout=mock"}}}`
- Security headers present on every response (`X-Frame-Options: DENY`, `nosniff`, referrer + permissions policy)
- **Better Auth works end to end**: signed up a user, received a session cookie, `get-session` returned it. Prisma defaults applied correctly (`roles: [CUSTOMER]`, `status: ACTIVE`), which is what lets Phase 2 layer role assignment on top. The smoke-test user was deleted afterwards; the dev database holds only seed data.

---

## What was implemented

### Monorepo — 2 apps, 5 packages, 50 TypeScript files

```
apps/web        Next.js 15 · React 19 · Tailwind 4 · Better Auth · health · UI primitives
apps/worker     pg-boss runtime, 6 queues registered, graceful shutdown
packages/domain      ports · Money · Result · DomainError · state machine   ← no framework, no ORM
packages/contracts   Zod env + API envelope + shared primitives
packages/db          Prisma schema, 2 migrations, seed, schema assertions
packages/adapters    MockPaymentGateway · MockPayoutProvider · ConsoleLogger
packages/config      tsconfig · ESLint (incl. the boundary rule) · Prettier
```

### The domain boundary is enforced, and the enforcement is itself tested

`packages/domain` may import only its own `ports/` and `@sfx/contracts`. An ESLint rule blocks React, Next, Prisma, `@sfx/db`, `@sfx/adapters`, and every vendor SDK.

A misconfigured `no-restricted-imports` fails _open_ — it would permit exactly what it exists to prevent, silently. So `architecture.test.ts` lints eight synthetic violations and asserts each is rejected, plus two legitimate imports and asserts those pass. If someone loosens the config, a test fails rather than the boundary quietly eroding.

### Database — 28 tables, tiered per your scope note

Tier 1 (schema + services + UI) / Tier 2 (insert-only, no reads or UI) / Tier 3 (not created). The C6 trim removed 8 tables from the build and collapsed `ExpertLanguage` and `ExpertCertification` into array columns. `MatchingConfigVersion` is gone — weights snapshot onto `MatchingRun` as JSON, per your C7 simplification.

**The load-bearing invariant is in the database, not in code:**

```sql
CREATE UNIQUE INDEX one_open_offer_per_expert
  ON matching_attempts (expertProfileId) WHERE status = 'OFFERED';
```

Prisma cannot express a partial index, so this lives in hand-written SQL — which makes it exactly the kind of thing a future schema reset can silently fail to recreate. `assert-schema.mjs` runs in verify and fails the build if it, or any of the other four partial indexes, goes missing or loses its `WHERE` clause or `UNIQUE`. It also fails if any `*_cents` / `*_amount` column ever becomes floating point.

Seed: 6 categories, 51 skills with aliases (the §2 taxonomy), matching weights and thresholds, and two clearly-placeholder pricing tiers.

### Your four amendments, as built

| Amendment                                                        | Where it landed                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Classifier promotion = evaluation trigger, not auto-switch**   | `classifier` config key carries `agreementThreshold: 0.85` / `evaluationWindow: 200`, documented as raising an evaluation, with promotion requiring a comparative run on the same sample. `SupportRequest.aiModel` records the model per request so the comparison is like-for-like. |
| **Sweep is sticky**                                              | `AvailabilityChangeSource.HEARTBEAT_TIMEOUT`, documented in the schema as never auto-restoring. `lastHeartbeatAt` on `ExpertProfile`; `expert_eligible_idx` covers `(availabilityStatus, lastHeartbeatAt)`.                                                                          |
| **Force Assign requires a reason and never bypasses acceptance** | `AttemptOrigin` is `ALGORITHMIC \| ADMIN_ASSIGN \| ADMIN_FORCE_ASSIGN`; `MatchingAttempt.adminReason`; the `OFFERED → OFFERED` admin transition carries guard `adminReasonProvided`. A test asserts **no admin path can reach `ACCEPTED`** — only `EXPERT` can.                      |
| **PHI prohibited; Health Cloud technical support allowed**       | Stated on the app's footer copy, noted against the `health-cloud` skill in the seed. Feeds the Phase 3 `SecretScanner` and the ToS.                                                                                                                                                  |

### State machine

§16 encoded as a data table with per-transition actor lists and named guards. D1 confirmed: the happy path is `CREATED → CLASSIFYING → SEARCHING → OFFERED → ACCEPTED → READY → IN_SESSION → COMPLETED`, with no payment step after an expert commits. `PAYMENT_PENDING` remains in the enum but unreachable, as the documented fallback.

16 tests cover it, including: no dead-end states, no state escapes a terminal one, only an expert can accept, no admin path reaches `ACCEPTED`, cancellation is impossible once an expert has committed, and no self-service refund.

### Money

Integer minor units throughout — no `Float` or `Decimal` on any monetary column, asserted by the schema check. `splitFee` computes the platform fee and derives the payout as the remainder, so `fee + payout === gross` exactly. Tested exhaustively across 2,000 amounts × 9 fee rates (18,000 cases); not one minor unit appears or vanishes.

---

## Assumptions made

1. **Currency is INR-first.** `PricingTier` and money columns default to `"INR"`. Trivially changed — Q2 is still open.
2. **Pricing is placeholder.** ₹1,000 / 30 min and ₹1,800 / 60 min at a 25% platform fee, deliberately round so nobody mistakes them for a decision. The price snapshot on `SupportRequest` means changing them never rewrites history.
3. **Platform fee is stored in basis points** (`2500` = 25.00%) rather than a decimal percent, so the rate itself is an integer and cannot drift.
4. **`AuthSession`, not `Session`.** Two things called "session" in a support product is a footgun; the auth model is renamed and mapped in Better Auth config. Verified working.
5. **Email verification is off** in Phase 1 — it needs the Mailer adapter, which is Phase 2.
6. **Dispute window is 7 days**, per the v2 architecture doc. Not yet enforced anywhere; it becomes the `withinDisputeWindow` guard in Phase 9.
7. **`robots: noindex`** on the whole app until Phase 11 opens the public pages.

---

## Three things you should know

**1. Prisma refused to reset the database, and I did not work around it.**

`prisma migrate reset` is the conventional way to prove migrations apply cleanly. Prisma now detects an AI agent driving it and blocks destructive database actions without your explicit consent — correctly, and there is an env var to override it that I deliberately did not use.

I got the same guarantee non-destructively instead: verify creates a throwaway database (`sfx_verify_<id>`), runs `migrate deploy` + schema assertions + seed into it, then drops it. That proves the migration set stands on its own rather than only applying on top of accumulated local state, and never touches your data.

Practical consequence: **`pnpm db:migrate:fresh` will prompt for your consent** if you or an agent runs it. That is working as intended. `pnpm verify` needs no such consent.

**2. `embedded-postgres` has no non-beta release.**

Local Postgres runs without Docker or a Homebrew service — the binary is downloaded into the project and the data directory is gitignored. But every published version of that package is beta-tagged, so I pinned `17.10.0-beta.17` exactly rather than using a caret range.

It is a devDependency only: never shipped, never in the request path, and CI uses a standard `postgres:17-alpine` service container instead. If you would rather run a real local Postgres, set `DATABASE_URL` to it and nothing else changes — verify detects an already-running server and uses it.

**3. I installed `pnpm` globally.**

Node 25 dropped corepack, so `npm i -g pnpm` was the only route. That is the one change outside this repo. Everything else — Postgres included — lives under the project directory.

---

## Files of note

| File                                                            | Why it matters                                       |
| --------------------------------------------------------------- | ---------------------------------------------------- |
| `packages/db/prisma/schema.prisma`                              | 28 tables, tiered, with the reasoning inline         |
| `packages/db/prisma/migrations/*_partial_indexes/migration.sql` | The concurrency invariant                            |
| `packages/db/scripts/assert-schema.mjs`                         | Fails the build if that invariant disappears         |
| `packages/domain/src/support-requests/state-machine.ts`         | §16 as data                                          |
| `packages/domain/src/architecture.test.ts`                      | Tests that the boundary rule actually fires          |
| `packages/config/eslint/domain.mjs`                             | The boundary rule itself                             |
| `packages/domain/src/ports/`                                    | 9 ports; payment and payout deliberately separate    |
| `apps/web/lib/container.ts`                                     | Composition root — the only place adapters are named |
| `scripts/verify.mjs`                                            | The gate, as a command                               |
| `.github/workflows/ci.yml`                                      | Same gate on a real Postgres service                 |

---

## Remaining TODOs

Carried forward, none blocking Phase 2:

- **Sentry is not wired.** It was on the Phase 1 list and I left it out: with no DSN it would be inert config, and `@sentry/nextjs` wants source-map upload credentials to be worth anything. Ten minutes once you have a DSN — say the word and I will add it at the top of Phase 2.
- **No `.js`-emitting build** for the packages; consumers transpile TS source. Fine for web + worker; revisit only if something needs to consume them as plain Node ESM.
- **CSP header** deferred to Phase 11, when the provider origins (Ably, Daily, payment gateway) are actually known. The other security headers are live now.
- **Nothing is committed to git.** The repo is initialised but I have not made a commit, since you have not asked me to.
- **Q2 (pricing numbers)** would be useful before Phase 3 seeds real tiers.

---

## Phase 2 scope, for reference

Registration and login (email + Google), customer and expert profiles, RBAC, the expert onboarding wizard with `DRAFT → SUBMITTED`, and the admin approval queue.

Exit criterion: an expert can be created, submitted, approved by an admin, and **only then** become eligible for matching.

Awaiting your go-ahead.
