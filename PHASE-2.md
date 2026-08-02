# Phase 2 — Accounts · Gate Summary

**Status:** Complete. `pnpm verify` green (9/9), end-to-end lifecycle green (41/41). Stopped before Phase 3.
**Date:** 2026-08-02
**Checkpoint:** Phase 1 committed as `6abcd51`. Phase 2 is uncommitted, awaiting approval.

---

## Gate results

```
── verify ──                                  ── e2e (real HTTP) ──
  ✓ format                                1.6s    41 passed, 0 failed
  ✓ lint                                  4.4s
  ✓ typecheck                             4.2s
  ✓ test                                  5.4s
  ✓ local postgres available              0.1s
  ✓ migrations apply to a fresh database   5.1s
  ✓ dev database is migrated and seeded    4.1s
  ✓ web builds                            15.3s
  ✓ worker boots                           1.5s
```

| Gate requirement | Result                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------- |
| Tests            | **116 passing** (was 55) — 96 domain, 13 adapters, 7 contracts                         |
| Lint             | Clean, 7 packages, zero warnings                                                       |
| TypeScript       | `tsc --noEmit` clean, `strict` + `noUncheckedIndexedAccess`                            |
| Fresh migrations | 3 migrations → throwaway database, 28 tables, 5 partial indexes asserted, seed applied |
| Build / boot     | Web builds (14 routes), worker registers 6 queues and exits cleanly                    |

### The exit criterion, exercised over HTTP

`pnpm e2e:phase2` drives a real server with real cookies. It is checked in at
[scripts/e2e/phase2-accounts.sh](scripts/e2e/phase2-accounts.sh) because the criterion is
behavioural — unit tests can prove the policy is right, only HTTP proves it is _wired_ right.

```
Requirement 1 — one account, two roles ................ 6/6
Requirement 2 — EXPERT role alone is not eligibility ... 5/5
Submit — completeness enforced server-side ............. 6/6
Requirement 4 — authorization is server-side .......... 4/4
Admin review .......................................... 8/8
Requirement 3 — audit trail ........................... 5/5
Suspension revokes eligibility immediately ............ 4/4
Illegal transitions ................................... 1/1
```

The headline path: a customer applies → dual-role on the same user id → DRAFT (not eligible) →
submitted (not eligible) → claimed (not eligible) → **approved (eligible)** → suspended (not
eligible) → reinstated (eligible).

---

## Your eight requirements, as built

### 1. Dual-role users — one identity

`User.roles` is a Postgres enum array, so applying to be an expert is a row update, not a signup.
`ExpertApplicationService.start` adds `EXPERT` to the existing user and creates a DRAFT profile.

Verified over HTTP: the user id is unchanged before and after, `roles` goes
`["CUSTOMER"] → ["CUSTOMER","EXPERT"]`, and the customer surface stays fully available. There is no
linked-accounts table and no "expert account" concept anywhere in the schema.

`CUSTOMER` is the baseline for every account — the customer profile is bootstrapped on the first
authenticated request of any session (covering email/password, Google, and any provider added
later) and is never removed when `EXPERT` is added.

### 2. The EXPERT role never confers eligibility

One function answers this, and it takes a **status, not an actor**:

```ts
export function isEligibleForMatching(status: ExpertStatus | undefined | null): boolean {
  return status === "APPROVED";
}
```

There is no parameter through which a role could be passed, so no future caller can accidentally
make one count. A test asserts the arity for exactly that reason.

Tested across all six statuses plus `undefined`/`null` (the pathological case: EXPERT role granted,
profile never created). Workspace access is gated on `APPROVED`, not on the role — and `/expert`
returns a **307 to the application page**, asserted as a redirect rather than as "something
rendered", which a 200 check would have let through.

### 3. Audit-friendly lifecycle

Every administrative decision writes an audit row **in the same transaction** as the status change,
so a status can never move without a record of who moved it. Each row carries the actor's id and
email, the actor type, the before/after status, the timestamp, and the reason.

The status machine declares which transitions require a reason, and the service enforces it — a
reasonless approve/reject/suspend/reinstate is a `VALIDATION_ERROR` and the status does not move.
`claim` is the one action that changes no outcome, so it does not demand one.

A test simulates a commit failure and asserts that **neither** the status change nor the audit row
survives. The admin UI renders the full history from these rows.

I used the existing `AuditLog` table rather than adding an `ExpertStatusHistory` — it already has
the right shape and the `(entityType, entityId, createdAt)` index, and requirement 5 argues against
a new table when one will do.

### 4. Authorization is server-side

`packages/domain/src/authorization/` holds the whole permission matrix as pure functions. Every
service method calls `authorize(actor, permission)` before touching data. The `Actor` is constructed
in exactly one place, entirely from the database — no code path reads roles, ids, or status from a
request body, so a client posting `{"roles":["ADMIN"]}` changes nothing.

The e2e run attacks it directly rather than trusting the UI: an applicant calling the admin approve
endpoint on their own application gets `FORBIDDEN`, a customer reading the review queue gets
`FORBIDDEN`, an anonymous caller gets `UNAUTHENTICATED`, and the application status is unchanged
after all three.

`permissions` _is_ sent to the client, for hiding unavailable buttons. It is presentation only —
the server re-decides every request, and a fabricated list buys nothing but a button that 403s.
A suspended account loses every permission including reading itself, checked before any grant.

### 5. No future-schema functionality

Phase 2 touched `User`, `CustomerProfile`, `ExpertProfile`, and `AuditLog`. The other 24 tables were
not built against. The expert workspace is a stub that says which phase each panel belongs to. No
availability toggle, no skills management, no request creation, no matching code.

### 6. Throwaway-database verification preserved

Unchanged and still not bypassed. `pnpm verify` creates `sfx_verify_<id>`, migrates and seeds into
it, asserts the schema, drops it. Prisma's destructive-action protection was not circumvented and
`PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` was not used.

### 7. `embedded-postgres` unchanged

Still pinned at `17.10.0-beta.17`, dev-only.

### 8. Sentry still deferred

No change.

---

## Schema change

One migration, `20260802091958_expert_draft_fields_nullable`:

- `country`, `timezone`, `yearsExperience`, `professionalSummary` → **nullable**
- `submittedAt` added (orders the review queue)

A DRAFT application is genuinely incomplete. Making those columns `NOT NULL` would force
placeholder values into the database to mean "unanswered", which is a worse representation than an
honest null. Completeness is enforced at the **submit boundary** by the domain instead, and
`missingForSubmission` returns _every_ outstanding field at once so one round trip tells the
applicant everything left to do.

---

## Two bugs the tests found, both fixed

**1. A concurrent "start application" would have 500'd.**

The race test failed on first run. Two simultaneous requests both read "no application", then both
insert; the `userId` unique constraint means one wins and the other raises `P2002`. That would have
surfaced as a 500 on a double-click.

Fixed properly rather than by adjusting the test: the adapter translates `P2002` into a domain
`ConflictError`, and the service catches it, re-reads, and returns the winner's row. A race is now
an idempotent success. The in-memory fake now models the unique constraint too — a fake more
permissive than production hides exactly the bugs it should surface.

**2. My own policy and service disagreed.**

The policy gated `expert_application:start` on "no application exists", which made the service's
idempotency branch unreachable and turned a double-click into a `403` — the wrong semantics, since
"you already applied" is a state fact, not a permission problem. The policy now permits it and the
service answers idempotently. The user still cannot end up with two applications; that is asserted
directly.

---

## Security and auth decisions

| Decision                                                | Reasoning                                                                                                                                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No self-service route to ADMIN**                      | A UI that can mint admins can be abused into minting one. The first admin is granted out of band via `pnpm --filter @sfx/db grant-role -- <email> ADMIN`, which writes an audit row in the same transaction as the grant. |
| **Actor built only from the database**                  | The single construction site is `lib/session.ts`. Input is never a source of identity or privilege.                                                                                                                       |
| **Suspended ⇒ zero permissions**                        | Checked before any grant, so no later branch can hand one back — including `account:read_self`.                                                                                                                           |
| **Terms acceptance stored as timestamps, not booleans** | If acceptance is ever questioned, _when_ is the part that matters. Unticking clears it.                                                                                                                                   |
| **Passwords ≥ 12 characters**                           | Better Auth `minPasswordLength: 12`.                                                                                                                                                                                      |
| **Google button hidden unless configured**              | A button that leads to a provider error is worse than no button. Env validation already rejects a half-configured pair.                                                                                                   |
| **Rejection is recoverable**                            | `REJECTED → DRAFT` on the next edit, so an applicant can rework and resubmit rather than being permanently dead-ended.                                                                                                    |
| **Audit rows outlive their subjects**                   | `actorUserId` is `SetNull` and `entityId` is not a FK, so deleting a user cannot erase the record that an admin approved them. Correct for an audit log, and worth knowing before anyone writes a GDPR-deletion routine.  |
| **Email verification still off**                        | Needs the Mailer adapter. Carried into Phase 3 with the rest of the notification work.                                                                                                                                    |

---

## Significant files

**New — domain (the part that matters)**

| File                                                        | Why                                                      |
| ----------------------------------------------------------- | -------------------------------------------------------- |
| `packages/domain/src/authorization/policy.ts`               | The whole permission matrix, exhaustively switched       |
| `packages/domain/src/authorization/actor.ts`                | `Actor`, `ANONYMOUS`, `isDualRole`                       |
| `packages/domain/src/experts/expert-status.ts`              | Lifecycle table + `isEligibleForMatching` + completeness |
| `packages/domain/src/experts/expert-application-service.ts` | Applicant use cases, race-safe start                     |
| `packages/domain/src/experts/expert-admin-service.ts`       | Admin decisions, each audited transactionally            |
| `packages/domain/src/ports/repositories.ts`                 | Repository ports + `UnitOfWork`                          |
| `packages/domain/src/experts/in-memory-uow.ts`              | Faithful fake, incl. the unique constraint               |
| `packages/domain/src/users/account-service.ts`              | Customer-profile bootstrap                               |

**New — tests (61 added)**

`authorization/policy.test.ts` (25) · `experts/expert-status.test.ts` (20) ·
`experts/expert-lifecycle.test.ts` (16) · `scripts/e2e/phase2-accounts.sh` (41 HTTP checks)

**New — adapters, contracts, scripts**

`packages/adapters/src/persistence/prisma-repositories.ts` ·
`packages/contracts/src/experts.ts` · `packages/db/scripts/grant-role.mjs` ·
`packages/db/prisma/migrations/20260802091958_expert_draft_fields_nullable/`

**New — web (14 routes)**

Pages: `(auth)/login`, `(auth)/register`, `(app)/dashboard`, `(app)/expert-application`,
`(app)/expert`, `(app)/admin/experts`, `(app)/admin/experts/[id]`
API: `v1/me`, `v1/expert-application` (GET/POST/PATCH), `v1/expert-application/submit`,
`v1/admin/experts`, `v1/admin/experts/[id]`, `.../decision`, `.../history`
Lib: `session.ts`, `route-helpers.ts`, `expert-view.ts`, `auth-client.ts`
UI: `input`, `textarea`, `checkbox`, `field`, `alert`, `status-badge`, `buttonClasses`

**Modified**

`packages/db/prisma/schema.prisma` (nullable draft fields, `submittedAt`) ·
`packages/domain/src/shared/errors.ts` (`IllegalTransitionError` made generic over the state type,
so the request and expert machines share it without casting) · `apps/web/lib/container.ts` (services
wired) · `packages/config/eslint/base.mjs` (ignore generated `next-env.d.ts`)

---

## Assumptions

1. **`REJECTED → DRAFT` on edit, not a separate "reopen" action.** Editing a rejected application is
   the intent to rework it; a second button would be ceremony. Audited as `expert_application.reopened`.
2. **`UNDER_REVIEW` is optional.** An admin may approve straight from `SUBMITTED`; claiming is for
   signalling to other admins, not a required step.
3. **Queue order is oldest-submission-first.** Whoever has waited longest is reviewed first.
4. **Admins can view DRAFT applications** (for support), but they never appear in the review queue.
5. **`languages` / `certifications` are free-text arrays**, per the Phase 1 C6 trim. Normalising into
   join tables is a later migration if matching ever needs it.
6. **Profile editing after approval is not built.** An approved expert cannot currently change their
   summary. That is Phase 4 (`/expert/profile`) — flagging it because it is a plausible thing to
   assume shipped.

---

## Deviations from the approved architecture

**None.** Two clarifications worth recording:

- **§9's status lifecycle gained one transition**: `REJECTED → DRAFT`. The spec listed the statuses
  but not the edges; without this, rejection is terminal and an applicant can never fix and resubmit.
- **No `ExpertStatusHistory` table.** Requirement 3 is satisfied by `AuditLog`, which already exists
  with the right shape and index. Adding a table would have contradicted requirement 5.

---

## Remaining TODOs

- **Sentry** — still deferred, per requirement 8.
- **Email verification and the Mailer adapter** — Phase 3.
- **Expert profile editing after approval** — Phase 4.
- **Rate limiting on auth endpoints** — Phase 11 per the roadmap, though sign-up/sign-in are now
  live routes. Worth pulling forward if this is deployed publicly before then.
- **CSP header** — Phase 11, once provider origins are known.
- **Q2 (pricing numbers)** — wanted before Phase 3 seeds real tiers.
- **Nothing committed** — awaiting your approval, then I will create the Phase 2 checkpoint.

---

## Phase 3 scope, for reference

Customer dashboard, the guided request form, category/skill selection, attachments via presigned R2
uploads, the request lifecycle through to `SEARCHING`, the `SecretScanner` warnings, and the
classifier behind `ProblemClassifier` (mock until a key exists).

Exit criterion: a customer can submit a request with attachments, it reaches `SEARCHING`, and the
state history is written.

Awaiting your review.
