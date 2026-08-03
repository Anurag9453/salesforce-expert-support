# Salesforce Instant Expert Support — Architecture (v2)

**Status:** Revised per review. Awaiting go-ahead for Phase 1. No implementation code written.
**Date:** 2026-08-02
**Supersedes:** v1 proposal (§40 items 1–10)

---

## 0. What changed from v1

| #   | Change                                                                                                                                                                       | Source                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| C1  | **Classifier defaults to Haiku 4.5, not Opus 5.** Model + provider set by config, not code. Accuracy measured in production before any upgrade.                              | Your Q5                      |
| C2  | **`PaymentGateway` and `PayoutProvider` are separate ports.** No Stripe commitment. Development runs on `MockPaymentGateway`. Provider chosen after India/global validation. | Your payments note           |
| C3  | **Primary-skill competence is a hard filter, not a score penalty**, with an absolute floor the relaxation ladder can never cross.                                            | Your Copado example          |
| C4  | **Expert heartbeat/presence** added to eligibility. Stale-available experts are swept offline.                                                                               | Your addition                |
| C5  | **Manual admin dispatch moves to Phase 6**, not Phase 10.                                                                                                                    | Your addition                |
| C6  | **Schema split into V1-operational / schema-only / deferred.** Roughly a third of v1's tables drop out of the build.                                                         | Your overengineering note    |
| C7  | **`MatchingConfigVersion` table deleted** — weights snapshot onto `MatchingRun` as JSON instead. Same auditability, one less table.                                          | Your simplification, applied |
| C8  | **Phase 6 is the formal MVP checkpoint**, with an explicit stop-and-assess gate.                                                                                             | Your principle               |
| C9  | Phase 7 splits into **7a (domestic) / 7b (cross-border + payouts)**.                                                                                                         | Follows from C2              |

**Confirmed as proposed:** separate worker (D2), monorepo (D3), payment authorization before matching (D1/Q1), Better Auth (Q4), 60s offer window (Q6), no session recording (Q8), manual refund review (Q10), disclosure model (Q11), platform-set pricing (Q12).

**Two mild pushbacks**, both flagged in §3 rather than silently applied: the earnings ledger and the availability log. I've kept both as insert-only tables with no services or UI, because both are near-free to write and genuinely painful to backfill. If you'd still rather drop them, say so and I will.

---

## 1. Architecture

```
                      ┌──────────────────────────────────────┐
   Web (Next.js)  ────▶│        /api/v1/*  (Route Handlers)   │
   iOS/Android    ────▶│        authn → validate → domain     │
   (future, RN)        └───────────────┬──────────────────────┘
                                       │
                             ┌─────────▼──────────┐
                             │  packages/domain   │  pure TypeScript
                             │  no framework, no  │  no I/O
                             │  SDK imports       │
                             │  ports/ ◀──────────┼── interfaces only
                             └─────────┬──────────┘
                                       │
   ┌────────────┬────────────┬─────────┴────────┬─────────────┬────────────┐
   │            │            │                  │             │            │
┌──▼──────┐ ┌───▼────────┐ ┌─▼──────────────┐ ┌─▼────────┐ ┌──▼───────┐ ┌──▼──────┐
│ Prisma  │ │ Payment    │ │ Problem        │ │ Video    │ │ Realtime │ │ Storage │
│ Postgres│ │ Gateway    │ │ Classifier     │ │ Provider │ │ Bus      │ │ Mailer  │
│         │ │ Payout     │ │                │ │          │ │          │ │         │
│         │ │ Provider   │ │ Haiku 4.5      │ │ Daily.co │ │ Ably     │ │ R2      │
│         │ │ ── MOCK ── │ │ (configurable) │ │          │ │          │ │ Resend  │
└──┬──────┘ └────────────┘ └────────────────┘ └──────────┘ └──────────┘ └─────────┘
   │
   │ pg-boss job tables (same database, transactional enqueue)
   │
┌──▼───────────────────────────────────────────────────┐
│  apps/worker  (always-on Node process)               │
│   classify-request · dispatch-next-offer             │
│   offer-timeout (t+60s) · matching-deadline (t+15m)  │
│   heartbeat-sweep (t+60s loop) · notification-dispatch│
└──────────────────────────────────────────────────────┘
```

`PaymentGateway` and `PayoutProvider` ship as `MockPaymentGateway` / `MockPayoutProvider` through Phase 6. Everything upstream — the state machine, the authorize-before-matching flow, the whole dispatch loop — is exercised end-to-end without a payment provider ever being chosen. That is what makes C2 cost nothing.

**Realtime remains a delivery optimisation, never a source of truth.** Every screen that consumes a realtime event can also derive its state from a plain `GET`. Dispatch correctness lives in Postgres.

---

## 2. Providers

| Concern               | Decision                                           | Status                   |
| --------------------- | -------------------------------------------------- | ------------------------ |
| Framework             | Next.js 15 App Router, TypeScript strict           | Fixed                    |
| Database              | PostgreSQL on Neon                                 | Fixed                    |
| ORM                   | Prisma; raw SQL for the candidate query only       | Fixed                    |
| Auth                  | **Better Auth**                                    | **Approved**             |
| Jobs/timers           | pg-boss + dedicated worker                         | Fixed                    |
| Realtime              | Ably                                               | Fixed                    |
| **Payments**          | **Undecided — `PaymentGateway` port, mock in dev** | **Deferred to Phase 7a** |
| **Payouts**           | **Undecided — separate `PayoutProvider` port**     | **Deferred to Phase 7b** |
| Video/screen-share    | Daily.co                                           | Fixed                    |
| Email                 | Resend + React Email                               | Fixed                    |
| Storage               | Cloudflare R2 (S3-compatible)                      | Fixed                    |
| **AI classification** | **`claude-haiku-4-5`, configurable**               | **Changed (C1)**         |
| Hosting               | Vercel (web) · Railway (worker) · Neon (db)        | Fixed                    |
| Observability         | Sentry · Axiom · PostHog                           | Fixed                    |

The rationale for the unchanged items is as in v1 and I won't repeat it. The two that changed:

### Payments — deliberately unresolved (C2)

Splitting the port in two is the substantive change, and it matters more than it looks:

```ts
interface PaymentGateway {
  // customer → platform
  authorize(req): Promise<Authorization>; // hold funds, don't capture
  capture(authId, amount): Promise<Capture>;
  void(authId): Promise<void>; // no expert found / cancelled
  refund(captureId, amount, reason): Promise<Refund>;
}

interface PayoutProvider {
  // platform → expert
  createRecipient(expert): Promise<RecipientRef>;
  payout(recipientRef, amount, currency): Promise<PayoutRef>;
  getStatus(payoutRef): Promise<PayoutStatus>;
}
```

Stripe Connect bundles these, which is exactly why v1 treated them as one thing — and exactly why that was wrong for you. Collecting payments from Indian customers and paying out to experts in several countries may well end up being two different providers, and a single fused abstraction would have quietly made that impossible.

**What actually determines the answer** (this is what Q3 is now asking):

1. **Where is the legal entity incorporated?** India-registered changes the available payment aggregators, the cross-border rules, and the outward-remittance path for paying foreign experts.
2. **Where do customers pay from?** Domestic INR is well served by Indian aggregators. International card payments into an Indian entity are export-of-services, with FIRC/FIRA documentation obligations.
3. **Where do experts get paid?** This is the genuinely hard axis. Domestic INR payouts are straightforward with Indian payout rails. Cross-border payouts to experts abroad, from an Indian platform, are materially more constrained and may need a different provider or a different contracting structure entirely.

I'd rather not assert specifics about current RBI rules or any provider's present-day terms — those change, and getting them wrong here would be worse than leaving the box empty. What I can commit to is that the architecture won't care: Phase 7a wires whichever gateway you pick for the dominant customer geography, 7b handles payouts and the cross-border case separately, and neither reaches past its port.

### AI classification — Haiku 4.5, measured then reconsidered (C1)

You're right that this is a constrained problem with a safe fallback. Design in §5.

---

## 3. Database schema

**Build discipline (C6).** Every table carries a tier. Tier 1 gets schema, services, and UI. Tier 2 gets schema and writes but no reads, services, or UI — these are the tables where a gap in history is expensive and the write is nearly free. Tier 3 is not created at all until its phase.

| Tier  | Meaning                                                           | Cost if deferred       |
| ----- | ----------------------------------------------------------------- | ---------------------- |
| **1** | Full build                                                        | —                      |
| **2** | Migration + insert-on-write only. No queries, no services, no UI. | Unbackfillable history |
| **3** | Not created in V1                                                 | Cheap to add later     |

Conventions unchanged: `cuid()` keys, timestamps everywhere, **money as `Int` cents/paise + ISO-4217 currency**, never floats.

### 3.1 Identity — Tier 1

```
User          id, email (unique citext), emailVerifiedAt, name, image,
              roles UserRole[], status, suspendedAt/Reason, lastLoginAt

Account       auth provider links (email+password, google) — Better Auth schema
Session       auth sessions (distinct from SupportSession)

CustomerProfile
              userId (unique), companyName?, timezone,
              preferredLanguages String[], paymentCustomerRef?
              -- provider-neutral ref, not stripeCustomerId (C2)

ExpertProfile
              userId (unique)
              status              DRAFT|SUBMITTED|UNDER_REVIEW|APPROVED|REJECTED|SUSPENDED
              statusChangedAt, reviewedByUserId?, reviewNotes?
              country, timezone, yearsExperience, professionalSummary
              languages String[]          ← denormalised (C6; was ExpertLanguage)
              certifications String[]     ← free text for admin review (C6)
              linkedinUrl?, githubUrl?, employmentStatus?
              termsAcceptedAt, confidentialityAcceptedAt

              -- presence (C4)
              availabilityStatus  OFFLINE | AVAILABLE | ON_OFFER | IN_SESSION
              lastHeartbeatAt?                    ← NEW
              lastAvailableAt?, lastAssignedAt?, lastSessionCompletedAt?

              -- metrics, recomputed on session completion
              sessionsCompleted, ratingSum, ratingCount,
              offersReceived, offersAccepted, avgResponseSeconds?

              payoutRecipientRef?, payoutsEnabled   -- provider-neutral (C2)
```

`ExpertLanguage` and `ExpertCertification` join tables are **Tier 3** — dropped. Postgres arrays cover V1's needs (language is a soft matching signal; certifications are read by a human reviewer). Normalising later is a migration, not a redesign.

### 3.2 Taxonomy — Tier 1

```
Category   id, slug (unique), name, parentId? → Category, displayOrder, isActive
Skill      id, slug (unique), name, categoryId, aliases String[], isActive
           -- aliases feed the classifier prompt: "LWC" ≈ "Lightning Web Component"

ExpertSkill
           expertProfileId, skillId,
           proficiencyLevel  BEGINNER | INTERMEDIATE | ADVANCED | EXPERT
           yearsExperience, verified, verifiedByUserId?, verifiedAt?
           unique(expertProfileId, skillId)
```

`Certification` — Tier 3.

### 3.3 Support requests — Tier 1

```
SupportRequest
  customerId, title, description, urgency (INSTANT)
  state, stateEnteredAt, version          -- optimistic concurrency
  primaryCategoryId?, difficulty?
  aiConfidence?, aiClassifiedAt?, aiModel?, aiFailureReason?   ← aiModel for C1 eval
  matchDeadlineAt
  assignedExpertId?
  -- price snapshot, frozen at creation
  pricingTierId, quotedPriceCents, currency,
  quotedPlatformFeeCents, quotedExpertPayoutCents
  paymentAuthorizationRef?                -- provider-neutral (C2)
  cancelledAt?, cancelledByUserId?, cancellationReason?

SupportRequestSkill
  supportRequestId, skillId,
  source     CUSTOMER_SELECTED | AI_DETECTED
  isPrimary, confidence?
  unique(supportRequestId, skillId, source)

SupportRequestStateHistory
  supportRequestId, fromState?, toState, reason?,
  actorType SYSTEM|CUSTOMER|EXPERT|ADMIN, actorUserId?, metadata Json
  index(supportRequestId, createdAt)

Attachment
  supportRequestId?, uploadedByUserId, storageKey (unique),
  filename, contentType, sizeBytes, redactionApplied
```

`Attachment.scanStatus` — Tier 3 (no AV scanning in V1; allowlist + size cap only).

### 3.4 Matching & audit — Tier 1

```
MatchingRun
  supportRequestId, roundNumber, relaxationLevel,
  weightsSnapshot Json,          ← C7: replaces MatchingConfigVersion table
  thresholdsSnapshot Json,
  candidatePoolSize, filtersApplied Json, startedAt, completedAt?

MatchingAttempt
  matchingRunId, supportRequestId, expertProfileId
  origin   ALGORITHMIC | ADMIN_MANUAL          ← C5
  rank?                                        -- null for admin-assigned
  skillScore, experienceScore, ratingScore,
  fairnessScore, reliabilityScore, finalScore
  scoreBreakdown Json                          -- per-skill detail
  status   RANKED|OFFERED|ACCEPTED|DECLINED|TIMED_OUT|SUPERSEDED|WITHDRAWN
  offeredAt?, respondedAt?, responseSeconds?, declineReason?
  index(supportRequestId, rank)
  unique(matchingRunId, expertProfileId)
```

Your C7 simplification is strictly better than what I had — the weights that produced a decision live on the decision itself, so an attempt is self-explaining without a join to a version table. One fewer table and better locality.

> **Invariant, enforced in the database:**
>
> ```sql
> CREATE UNIQUE INDEX one_open_offer_per_expert
>   ON "MatchingAttempt" ("expertProfileId") WHERE status = 'OFFERED';
> ```
>
> "An expert can never hold two live offers" becomes structurally impossible rather than merely intended. Application checks race; a partial unique index does not.

```
ExpertAvailabilityLog                          ← TIER 2 (see note)
  expertProfileId, fromStatus?, toStatus,
  source  MANUAL_TOGGLE | HEARTBEAT_TIMEOUT | OFFER_LOCK | SESSION_START | ADMIN
  createdAt
```

> **Mild pushback, your call.** You listed this among the deferrable tables. It's one `INSERT` inside the availability-transition function that already exists — call it four lines — and it's the only way to answer "was this expert actually online when we say they were?" That question comes up the first time an expert disputes their acceptance-rate metric, and it cannot be reconstructed after the fact. I've marked it **Tier 2**: write only, no reads, no UI, no admin screen. If you'd still rather have zero, say so.

### 3.5 Sessions

```
SupportSession                                          -- Tier 1, Phase 8
  supportRequestId (unique), customerId, expertId, state,
  videoProvider, videoRoomId, videoRoomExpiresAt,
  scheduledDurationMinutes, startedAt?, endedAt?,
  priceCents, platformFeeCents, expertPayoutCents, currency,
  resolutionStatus?, expertNotes?, expertNotesSharedWithCustomer

SessionParticipantEvent                                 -- Tier 1, Phase 8
  sessionId, userId, eventType (JOINED|LEFT|RECONNECTED), occurredAt
  -- kept because "did this session actually happen?" gates payment capture.
  -- Not billing-critical (flat per-tier pricing), but capture-critical.

Rating                                                  -- Tier 1, Phase 9
  sessionId (unique), raterUserId, ratedExpertId, stars 1..5, review?, isPublic
```

`SessionMessage` — **Tier 3.** Daily provides in-call chat; we don't need our own transcript store in V1.

### 3.6 Money

```
PricingTier                                             -- Tier 1
  name, durationMinutes, priceCents, currency,
  platformFeePercent, isActive, effectiveFrom, effectiveTo?

Payment                                                 -- Tier 1, Phase 7a
  supportRequestId, customerId, provider, providerRef (unique),
  amountCents, currency,
  status  REQUIRES_METHOD|AUTHORIZED|CAPTURED|FAILED|CANCELLED
        | REFUNDED|PARTIALLY_REFUNDED
  authorizedAt?, capturedAt?, failureCode?, failureMessage?

Refund                                                  -- Tier 1, Phase 7a
  paymentId, providerRef (unique), amountCents, reason,
  initiatedByUserId?, status

WebhookEvent                                            -- Tier 1, Phase 7a
  provider, externalEventId, eventType, payload Json, processedAt?, error?
  unique(provider, externalEventId)      -- duplicate delivery is a no-op

EarningsLedgerEntry                                     ← TIER 2 (see note)
  expertProfileId, entryType  SESSION_EARNING|ADJUSTMENT|REFUND_CLAWBACK|PAYOUT
  amountCents (signed), currency, sourceType, sourceId, availableAt, description

ExpertPayout                                            -- Tier 3, Phase 7b
```

> **Mild pushback, your call.** You flagged the ledger. I agree completely that the _earnings UI_ (§24: available / pending / total earned) is Phase 9 work and shouldn't be built now. What I'd keep is the **write**: one `INSERT` when a session completes, from Phase 7a. The reason is narrow — a ledger reconstructed from session history later will silently disagree with reality the moment there has been a single refund, adjustment, or partial capture, and you will not know which number is wrong. Writing entries from the first paid session costs almost nothing and makes the eventual earnings screen a pure `SELECT SUM`. **Tier 2: written, never read, no service, no UI.** Balances stay computed aggregates; there is no mutable `balance` column anywhere, ever.

### 3.7 Platform

```
PlatformConfiguration     -- Tier 1: key/value Json. Matching weights live here.
Notification              -- Tier 1: userId, eventType, channel, payload, status
AuditLog                  -- Tier 1, narrow: admin mutations + auth events only.
                          --   Not a general-purpose event log in V1.
```

### 3.8 Indexes for the hot path

```sql
CREATE INDEX ON "ExpertProfile" ("status","availabilityStatus","lastHeartbeatAt")
  WHERE "status" = 'APPROVED';
CREATE INDEX ON "ExpertSkill" ("skillId","proficiencyLevel");
CREATE INDEX ON "SupportRequest" ("state","matchDeadlineAt")
  WHERE "state" IN ('SEARCHING','OFFERED');
CREATE UNIQUE INDEX one_open_offer_per_expert
  ON "MatchingAttempt" ("expertProfileId") WHERE status = 'OFFERED';
```

**Net effect of C6:** 8 tables removed from the V1 build, 2 reduced to insert-only, `ExpertLanguage`/`ExpertCertification` collapsed into array columns.

---

## 4. State machine

Unchanged from v1 except that D1 is now confirmed, so `PAYMENT_PENDING` is gone from the happy path.

| From                  | To                       | Trigger                                              | Guard                                   |
| --------------------- | ------------------------ | ---------------------------------------------------- | --------------------------------------- |
| —                     | `CREATED`                | Customer submits                                     | `PaymentGateway.authorize()` succeeded  |
| `CREATED`             | `CLASSIFYING`            | Worker picks up                                      | —                                       |
| `CLASSIFYING`         | `SEARCHING`              | Classified **or** classifier failed/timed out        | Fallback to customer-selected skills    |
| `SEARCHING`           | `OFFERED`                | Candidate selected                                   | ≥1 eligible candidate                   |
| `SEARCHING`           | `NO_EXPERT_FOUND`        | Pool exhausted at max relaxation, or deadline passed | —                                       |
| `OFFERED`             | `ACCEPTED`               | Expert accepts                                       | Attempt still `OFFERED`                 |
| `OFFERED`             | `SEARCHING`              | Decline or 60s timeout                               | Candidates remain, deadline not passed  |
| `OFFERED`             | `NO_EXPERT_FOUND`        | Decline/timeout                                      | No candidates remain or deadline passed |
| `ACCEPTED`            | `READY`                  | Session + video room created                         | Authorization still valid               |
| `READY`               | `IN_SESSION`             | First participant joins                              | —                                       |
| `IN_SESSION`          | `COMPLETED`              | Either ends, or duration + grace elapses             | Triggers `capture()`                    |
| `COMPLETED`           | `DISPUTED`               | Customer disputes within 7 days                      | —                                       |
| `DISPUTED`            | `COMPLETED` / `REFUNDED` | Admin resolves                                       | Admin only                              |
| pre-`ACCEPTED`        | `CANCELLED`              | Customer cancels                                     | Triggers `void()`                       |
| `SEARCHING`/`OFFERED` | `OFFERED`                | **Admin manual assign**                              | **Admin only (C5)**                     |

`PAYMENT_PENDING` is retained in the enum but unreachable — the fallback path if a future gateway can't do authorize-then-capture. Terminal: `NO_EXPERT_FOUND`, `CANCELLED`, `REFUNDED`, and `COMPLETED` after the dispute window.

A single `transition()` function is the only code path that mutates `state`. It locks the row (`SELECT … FOR UPDATE`), validates the pair against this table, evaluates the guard, bumps `version`, writes history, and enqueues side-effect jobs **inside the same transaction** — pg-boss being Postgres-backed means a state change can never commit with its follow-up job lost. No boolean flags anywhere.

---

## 5. Matching algorithm

### Stage 1 — Hard filters

An expert is eligible only if **all** hold:

1. `status = APPROVED`
2. `availabilityStatus = AVAILABLE`
3. **`lastHeartbeatAt > now() − heartbeatStaleAfter`** _(C4, default 3 min)_
4. No open offer, no active session
5. **Holds every primary skill at ≥ `minPrimaryProficiency`** _(C3)_
6. Has not already declined or timed out on this request
7. Shrunk rating ≥ `minRating` (default 3.5), waived below 3 rated sessions
8. Language overlap, if the customer specified one

### The primary-skill floor (C3)

This is the change your Copado example demanded, and it's a filter rather than a discount:

```
minPrimaryProficiency  =  ADVANCED       at relaxation 0–1
                       =  INTERMEDIATE   at relaxation 2–3
                       ≥  INTERMEDIATE   ALWAYS — no relaxation level may go below
```

An expert missing _any_ primary skill, or holding one below the floor, is **not a candidate** — they never appear in the ranking at all, regardless of how strong they are elsewhere.

`skillScore` also changes shape so a weak link stays visible when candidates _do_ qualify:

```
weightedAvg = Σ(weightᵢ × proficiencyᵢ) / Σ(weightᵢ)     primary 1.0, secondary 0.5
minPrimary  = min(proficiency across primary skills)
skillScore  = 0.7 × weightedAvg + 0.3 × minPrimary
```

Proficiency maps `BEGINNER 0.25 / INTERMEDIATE 0.50 / ADVANCED 0.75 / EXPERT 1.00`, ×1.1 capped at 1.0 when `verified`.

**Your Copado case.** Request: Copado _(primary)_, Git, Metadata Deployment.

|          | Copado   | Git          | Deploy      | Filter           | skillScore |
| -------- | -------- | ------------ | ----------- | ---------------- | ---------- |
| Expert A | EXPERT   | ADVANCED     | ADVANCED    | **passes**       | 0.913      |
| Expert B | BEGINNER | INTERMEDIATE | EXPERT (SF) | **disqualified** | —          |

B is excluded at relaxation 0 _and stays excluded at maximum relaxation_, because BEGINNER is below the absolute INTERMEDIATE floor. The generalist never reaches this request. That's the behaviour you asked for, and it's the mechanism — not the weighting — that guarantees it.

### Stage 2 — Scoring (survivors only)

- **`experienceScore`** = `0.6 × min(years/10, 1) + 0.4 × min(avgSkillYears/8, 1)`
- **`ratingScore`** = Bayesian-shrunk: `(5 × 4.5 + ratingSum) / (5 + ratingCount) / 5`. One 5-star review must not outrank a hundred 4.8s.
- **`fairnessScore`** = `min(idleMinutes / 240, 1) × (1 − 0.3 × min(sessionsToday/6, 1))`
- **`reliabilityScore`** = `0.8 × shrunkAcceptRate + 0.2 × speedBonus`

Weights live in `PlatformConfiguration` and snapshot onto `MatchingRun.weightsSnapshot`:

| Skill    | Rating   | Experience | Fairness | Reliability |
| -------- | -------- | ---------- | -------- | ----------- |
| **0.40** | **0.20** | **0.15**   | **0.15** | **0.10**    |

**Ranking is banded, then scored.** Candidates are ordered first by the _ordinal
proficiency level of their weakest primary skill_, and only within a band by
`finalScore`. Ties then break on longer idle time, then a per-request seeded hash.

That structure replaced score-only ranking during Phase 5, because a test showed
weights alone cannot deliver C3's intent. With `skill 0.40` against
`rating 0.20 + experience 0.15 + fairness 0.15 + reliability 0.10`, a candidate
maxed on every non-technical axis gains ≈0.21 while a whole proficiency level of
primary skill is worth ≈0.13 — so a merely-INTERMEDIATE expert beat a verified
EXPERT. Banding makes primary competence _dominate_ rather than merely
contribute: no combination of rating, tenure, fairness or reliability can promote
a candidate out of their band, while inside a band all of them still reorder
similarly-qualified experts. Same lesson as the floor itself, one layer up:
the guarantee has to be structural, not a weight someone can retune.

The band uses the _declared_ level, not the verified-adjusted value, so
verification helps within a band and can never be the thing that gets an expert
work.

**§14 regression case** (A: 8y, 4.9, 10 min ago · B: 7y, 4.8, 3h ago) → **A 0.719, B 0.806**. B wins by 0.087, exactly as §14 intends, while A's real edge on rating and experience is preserved rather than discarded. This is a committed test, not an illustration. _(The absolute values are lower than this section first estimated — the weakest-primary term in `skillScore` costs both candidates the same amount. The margin, which is what §14 is about, is unchanged.)_

### Stage 3 — Relaxation ladder, floored (C3)

| Level | At     | Relaxes                                           | Never relaxes              |
| ----- | ------ | ------------------------------------------------- | -------------------------- |
| 0     | t+0    | —                                                 | primary ≥ ADVANCED         |
| 1     | ~t+4m  | rating floor; secondary-skill coverage → ≥50%     | primary ≥ ADVANCED         |
| 2     | ~t+8m  | primary floor → INTERMEDIATE; language preference | **primary ≥ INTERMEDIATE** |
| 3     | ~t+12m | widen secondary skills to parent category         | **primary ≥ INTERMEDIATE** |
| —     | t+15m  | `NO_EXPERT_FOUND`                                 | —                          |

There is no level at which "any available Salesforce expert" becomes a candidate. Your framing is the right one and I've encoded it literally: **a wrong expert is worse than no expert**, because the product's entire promise is that we chose correctly. An honest `NO_EXPERT_FOUND` costs one refund and one apology. A CPQ pricing-rule question routed to a Flow admin costs the brand.

### Stage 4 — Dispatch loop

```
on enter SEARCHING:
  run  = createMatchingRun(request, weightsSnapshot, relaxationLevel)
  pool = filter → score → rank → take(10)
  persist MatchingAttempt rows (RANKED)     ← audit trail incl. experts never offered
  → dispatchNextOffer(run)

dispatchNextOffer(run):
  next = first RANKED by rank
  if none:
      relaxationLevel < 3 and now < deadline ? relaxationLevel++ ; re-enter SEARCHING
                                             : transition(NO_EXPERT_FOUND) + void()
  else:
      transaction:
        attempt → OFFERED, offeredAt = now      ← partial unique index makes a
        expert  → ON_OFFER                         double-offer impossible
        transition(request, OFFERED)
        schedule offer-timeout at +60s
      publish: realtime · browser push · sound · email fallback

on accept:  atomic UPDATE … WHERE status='OFFERED'   ← idempotent; a late second
            cancel timeout; supersede siblings          accept is a clean no-op
            → ACCEPTED → create session + room → READY

on decline/timeout:  mark attempt; expert → AVAILABLE; → SEARCHING → dispatchNext

matching-deadline job at +15m: if still searching → NO_EXPERT_FOUND + void()
```

Re-ranking on every relaxation step means experts who came online mid-search enter the pool.

### Presence and heartbeat (C4)

Your point is exactly right — an expert who toggled 🟢 at 9 AM and walked away poisons the pool: they absorb an offer, burn 60 seconds of a 15-minute budget, and take an undeserved hit to their acceptance rate.

- The expert dashboard `POST`s a heartbeat every **45 s** while the tab is open and `availabilityStatus = AVAILABLE`.
- Eligibility requires `lastHeartbeatAt > now() − 3 min`.
- A `heartbeat-sweep` job runs every 60 s, flips stale `AVAILABLE` experts to `OFFLINE`, logs `source = HEARTBEAT_TIMEOUT`, and pushes a realtime "you've been marked offline" notice so it's never silently surprising.
- **Offers to swept experts don't count against `offersReceived`**, so presence problems can't quietly damage someone's reliability score.

One practical caveat worth designing around now: browsers throttle `setInterval` in background tabs to roughly once a minute. A 3-minute stale window tolerates that; anything tighter would start sweeping people who are merely on another tab. We also fire an immediate heartbeat on `visibilitychange → visible`. Genuine presence needs the mobile app — which is exactly the driver/delivery-app experience you described, and another reason the API stays mobile-shaped from Phase 4.

### Manual admin dispatch (C5)

Agreed, and I'd go further than "useful" — during the first hundred customers this is the difference between a recoverable incident and a refund with an apology. It lands in **Phase 6**, alongside the automation it's insuring.

- `POST /api/v1/admin/requests/:id/dispatch` with `mode: "assign"` → creates a `MatchingAttempt` with `origin = ADMIN_ASSIGN`, `rank = null`, bypasses scoring, offers with the normal 60 s window. The expert must still be approved, available and present.
- The same route with `mode: "force"` → `origin = ADMIN_FORCE_ASSIGN`. Overrides the competence filters, the ranking, and the availability requirement, so it can reach an expert who is OFFLINE. **It does not skip the offer.**
- Both require a typed reason and write `AuditLog`, so a manual intervention is visibly distinct from an algorithmic decision forever after.

> **Amended in Phase 2, implemented in Phase 5.** This section originally sent
> force-assign straight to `ACCEPTED`. The user overruled that: _"Force Assign
> requires reason and never bypasses acceptance."_ Consent is not the operator's
> to give, however good their reason — an expert must never find themselves
> committed to a session they did not agree to. Force Assign therefore overrides
> every _rule_ and no _person_: it produces an ordinary offer with the ordinary
> 60-second window and the ordinary accept/decline buttons, and the expert may
> decline it like any other. There is no parameter, anywhere, that skips that.

`extend-deadline` is **not built**. Requirement 7 fixes the 15-minute window at submission, and the only honest reason to extend it is a customer explicitly agreeing to wait longer — which is a conversation, not a button. Deferred rather than dropped.

The admin queue view shows in-flight requests with elapsed time, current relaxation level, and every attempt with its outcome — so the operator can see _"3 experts timed out, currently at relaxation 2"_ and act, rather than guess.

---

## 6. AI classification (C1)

```ts
interface ProblemClassifier {
  classify(input: ClassificationInput): Promise<ClassificationResult | null>;
}
```

Returning `null` rather than throwing makes the fallback the ordinary path, not an exception path.

**Model: `claude-haiku-4-5`** ($1 / $5 per MTok), set by `CLASSIFIER_MODEL` env var with the provider behind the port. Your reasoning holds: mapping _"LWC isn't refreshing after an imperative Apex call"_ → `Salesforce Development / [LWC, Apex] / Intermediate` is a constrained labelling task against a closed taxonomy, with a customer-selected fallback if it fails. Frontier reasoning per request isn't what's being bought.

**The output cannot be wrong in shape.** The JSON schema's `skills` field is an `enum` generated at runtime from active `Skill.slug` rows, so a hallucinated skill is structurally impossible rather than something we validate away afterwards. Structured outputs are supported on Haiku 4.5.

**Three implementation details that matter:**

- **Prompt caching has a 4096-token minimum on Haiku 4.5** (versus 512 on Opus 5). Our taxonomy prefix must clear that bar or caching silently never engages — no error, just full price on every call. I'll assert the cached prefix length in a test and verify `cache_read_input_tokens > 0` in staging rather than assuming it.
- **Haiku 4.5 does not accept the `effort` parameter** (it errors). No thinking config; a bare classification call.
- **Deterministic serialisation** of the taxonomy (sorted keys) — otherwise the prefix bytes drift and the cache never hits.

**Never on the critical path.** A worker job with a 4-second budget and one retry. On failure: record `aiFailureReason`, keep customer-selected skills, proceed to `SEARCHING`. Dispatch never awaits the classifier.

**Measurement before any upgrade.** Both skill sets are stored (`SupportRequestSkill.source`), and `aiModel` is recorded per request, so from day one we can compute:

- primary-category agreement rate vs the customer's own selection
- skill-set Jaccard overlap
- how often an expert's post-session notes contradict the classification
- p50/p95 latency and cost per request

**Promotion rule, agreed in advance:** if primary-category agreement falls below **85%** over a 200-request window, escalate to `claude-sonnet-5` and re-measure. That's a config change and a redeploy, not a code change. The decision becomes data rather than instinct — which was your point.

**Redaction before transmission.** The classifier receives redacted text (§7).

---

## 7. Repository structure

```
salesforce-expert-support/
├── apps/
│   ├── web/                      Next.js 15 — the only package that knows React
│   │   ├── app/  (marketing) (auth) (customer) (expert) (admin) api/v1 api/webhooks
│   │   ├── components/{ui,shared,customer,expert,admin}/
│   │   └── lib/                  composition root: ports → adapters
│   └── worker/src/jobs/          classify-request · dispatch-next-offer
│                                 offer-timeout · matching-deadline
│                                 heartbeat-sweep · notification-dispatch
├── packages/
│   ├── domain/                   ★ pure TS. No next/react/prisma/SDK imports.
│   │   └── src/
│   │       ├── ports/            PaymentGateway · PayoutProvider · VideoProvider
│   │       │                     Mailer · Storage · ProblemClassifier
│   │       │                     RealtimeBus · PushSender · Clock · IdGenerator
│   │       ├── matching/         scoring.ts (pure) · candidates.ts (SQL)
│   │       │                     dispatch.ts · presence.ts · config.ts
│   │       ├── auth/ users/ experts/ support-requests/
│   │       ├── sessions/ payments/ notifications/ classification/ admin/
│   │       └── shared/           Money · Result · DomainError · state-machine
│   ├── adapters/                 Prisma · Mock+real payments · Daily · Ably
│   │                             · R2 · Resend · Claude — one per port
│   ├── db/                       prisma/schema.prisma · migrations · seed
│   ├── contracts/                Zod schemas + inferred types.
│   │                             Shared by web, worker, and future mobile.
│   └── config/                   eslint · tsconfig · tailwind presets
├── e2e/                          Playwright
└── turbo.json · pnpm-workspace.yaml
```

**The load-bearing rule:** `packages/domain` imports nothing but its own `ports/`. An ESLint `no-restricted-imports` rule enforces it in CI, so it fails loudly rather than eroding.

Two payoffs. The matching engine is testable as pure functions — the entire §35 scenario list runs in milliseconds with no database. And extracting a standalone API service for mobile later is a deployment change, not a rewrite.

**Security by layer (§30–31):** authorization in the domain (`can(user, action, resource)`), invoked in every service method — never only in the route handler. Zod validation on every input. Rate limiting at the edge on auth, request creation, upload. Boot-time `env` validation so a missing secret fails the build, not production. Attachments: extension + MIME + magic-byte allowlist, private bucket, short-TTL signed URLs issued only after a server-side authorization check. Webhook signature verification plus `WebhookEvent` uniqueness for replay safety.

**Salesforce secret redaction (§31):** a `SecretScanner` in the domain runs a pattern set — org/session IDs (`00D…!`), `sk_`/`pk_` keys, OAuth bearer tokens, `-----BEGIN … PRIVATE KEY-----`, `password=` assignments — over descriptions and text attachments. V1 warns the customer inline before submission and redacts before the classifier call. The port exists from day one so redaction-at-rest can be enabled later without touching call sites.

---

## 8. Roadmap

Each phase ends with the §40 gate: tests, lint, `tsc --noEmit`, migrations verified against a fresh database, both apps boot, plus a written summary of what shipped, files changed, assumptions made, and open TODOs.

| Phase                 | Scope                                                                                                                                                                                                                                                          | Exit criteria                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **1 — Foundation**    | Turborepo · Next.js · TS strict · Prisma + Neon · pg-boss · Better Auth · CI · design system · `env` validation · Sentry                                                                                                                                       | `pnpm verify` green; migrations apply to empty DB; both apps boot                                                   |
| **2 — Accounts**      | Register/login (email + Google) · profiles · RBAC · expert onboarding DRAFT→SUBMITTED · admin approval queue                                                                                                                                                   | Expert created → submitted → approved → only then eligible                                                          |
| **3 — Requests**      | Customer dashboard · guided request form · taxonomy + seed · attachments (R2 presigned) · lifecycle to `SEARCHING` · secret-scan warnings · **`MockPaymentGateway.authorize()`**                                                                               | Request with attachments reaches `SEARCHING`; history written; mock authorization recorded                          |
| **4 — Availability**  | Expert dashboard · availability toggle · **heartbeat + sweep job (C4)** · expert skill management                                                                                                                                                              | Closing the tab marks the expert offline within 3 min; API is mobile-shaped                                         |
| **5 — Matching** ⭐   | Filters · **primary-skill floor (C3)** · scoring · ranking · fairness · `MatchingRun`/`MatchingAttempt` · offer lifecycle · timeout · next-expert routing · floored relaxation ladder                                                                          | **Every §35 scenario tested**, incl. concurrency. §14 example and the Copado disqualification are regression tests. |
| **6 — Dispatch** ⭐⭐ | Ably · expert offer UI · customer "Finding the right Salesforce expert…" → "Expert found" · accept/decline/timeout · browser push + sound + email fallback · **minimal admin ops console: in-flight queue, manual assign, force-assign, extend deadline (C5)** | **MVP CHECKPOINT — see below**                                                                                      |
| **7a — Payments**     | Chosen gateway · authorize-then-capture · webhook idempotency · refunds · ledger writes (Tier 2)                                                                                                                                                               | Duplicate webhook provably a no-op; authorization voided on `NO_EXPERT_FOUND`                                       |
| **7b — Payouts**      | `PayoutProvider` · recipient onboarding · payout execution · cross-border path                                                                                                                                                                                 | Blocked on Q3                                                                                                       |
| **8 — Sessions**      | Session creation · Daily rooms + scoped tokens · join/leave events · completion → capture                                                                                                                                                                      | Full call with screen share; capture gated on real participation                                                    |
| **9 — Reviews**       | Resolution status · 1–5 rating · review · expert notes (private vs shared) · metric recompute · **earnings UI**                                                                                                                                                | Ratings feed `ratingScore` on the next match                                                                        |
| **10 — Admin**        | Full dashboard: matching inspection with per-component scores and offer timeline · payments · categories · platform metrics                                                                                                                                    | For any request, an admin can answer "why B and not A" from the UI alone                                            |
| **11 — Hardening**    | Rate limits · security review · structured logging · monitoring · backups **+ an actual restore drill** · load test on the candidate query · a11y · SEO                                                                                                        | Restore performed, not merely configured                                                                            |

### ⭐⭐ Phase 6 — the MVP checkpoint

Your framing, adopted as a formal gate. At the end of Phase 6 we should be able to open two browsers and demonstrate:

> **Customer:** "I need Apex help" → **System:** classifies as Apex → **Matching engine:** ranks and selects → **Expert:** receives a realtime offer → **Expert:** accepts → **Customer:** sees "Expert found"

with the admin console able to intervene at any point. **That is the heart of the company.** Payments, video, ratings, and analytics are layers around a thing that either works or doesn't.

I'll **stop there and write an assessment** before starting Phase 7 — what the dispatch loop actually feels like end to end, where the latency sits, whether 60 seconds is right, and whether the ranking produces sensible choices on seeded data. If something about the core loop is wrong, that's the moment to find out, before payment and video integrations make it expensive to change.

---

## 9. Testing (§35)

- **Unit (pure domain, no DB, milliseconds):** scoring, primary-skill floor, fairness, state-machine legality, money arithmetic, secret scanner, heartbeat staleness. The §35 scenario list lives here.
- **Integration (real Postgres via Testcontainers):** repositories, transitions with history, the partial unique index actually rejecting a double offer, webhook idempotency, sweep job correctness.
- **Concurrency (explicit):** N parallel dispatchers on one request → exactly one offer. N parallel accepts on one offer → exactly one winner. Accept racing timeout at the boundary. These catch the bugs that only surface in production.
- **E2E (Playwright):** the §38 flow, two browser contexts, fake clock so the 60 s timeout doesn't slow CI.
- **Contract:** every `/api/v1/*` response validated against its Zod schema, so the future mobile client can trust the shape.

Named regression tests, committed as specifications rather than examples: **the §14 fairness case** and **the Copado primary-skill disqualification**.

---

## 9a. Pre-deployment gates

Things that are correct for local development and **wrong in production**. Each is wired now, at
the right call sites, so the fix is a swap in the composition root rather than an audit of every
route. None of these may ship to a public URL unresolved.

| #      | Gate                                | Current state                                                                                               | What must change                                                                                                                                                    | Added   |
| ------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **G1** | **Rate limiting on a shared store** | `InMemoryRateLimiter` — per-process fixed window. Applied to auth, request creation, and attachment upload. | Back `RateLimiter` with Redis/Upstash. The in-memory limiter is per-instance: with N instances an attacker gets N× the limit, and every deploy resets the counters. | Phase 3 |
| **G2** | **Object storage**                  | `LocalFileStorage` — signed URLs, path containment, private reads, but files on the app server's disk.      | Swap for the R2/S3 adapter. Local disk does not survive a redeploy and does not exist on serverless.                                                                | Phase 3 |
| **G3** | **Content Security Policy**         | Other security headers are live; CSP is not.                                                                | Add CSP once the provider origins (Ably, Daily, the payment gateway) are known.                                                                                     | Phase 1 |
| **G4** | **Error reporting**                 | Not wired.                                                                                                  | Sentry, once a DSN exists.                                                                                                                                          | Phase 1 |
| **G5** | **`embedded-postgres`**             | Pinned dev-only dependency, beta-tagged.                                                                    | Managed Postgres (Neon) in every deployed environment. Never ships.                                                                                                 | Phase 1 |

**G1 in detail.** Rate limiting was originally scheduled for Phase 11 hardening. That was wrong:
sign-up, sign-in, and request submission are live routes from Phases 2 and 3, and request submission
authorizes a payment on every call. The limits and their call sites exist now
(`RATE_LIMITS` in `packages/domain/src/ports/rate-limiter.ts`); only the backing store is
outstanding.

One caveat that comes with it: the unauthenticated limit keys on `x-forwarded-for`, which is
trustworthy on Vercel and spoofable on a platform that does not strip inbound copies. Verify that
property for whichever platform is chosen.

---

## 10. Remaining open questions

Down from fourteen to five. **Q2 and Q3 block Phase 7; nothing blocks Phase 1.**

| #       | Question                                                                                                                                                                                            | Blocks            | Notes                                                                                                                                                                                                                                 |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Q2**  | **Pricing.** Session durations, price per duration, platform fee %, currency.                                                                                                                       | Phase 3 seed data | 30/60 min, INR primary? I need real numbers. A placeholder is fine to start — the snapshot design means changing them later doesn't rewrite history.                                                                                  |
| **Q3**  | **Entity + geography.** Where is the entity incorporated? Which countries do customers pay from? Which countries do experts get paid in?                                                            | **Phase 7a/7b**   | This determines the gateway and payout provider, and nothing else in the build. Answerable during Phases 1–6.                                                                                                                         |
| **Q7**  | **`NO_EXPERT_FOUND` follow-up.** You've confirmed the honest message is right. Do we also offer a scheduled callback, or just refund and apologise?                                                 | Phase 6 UX        | Refund + apology in V1; a "notify me when someone's available" opt-in is a small addition if you want it.                                                                                                                             |
| **Q9**  | **PHI / regulated data.** §2 lists Health Cloud; §31 mentions patient information. If PHI can reach the platform, every subprocessor needs a data-protection agreement and the vendor list changes. | Legal, not code   | My recommendation: explicit ToS prohibition on sharing PHI or production customer data, prominent in-product warning, no recording. **Please confirm** — this is the one open item with consequences that reach outside the codebase. |
| **Q14** | **Launch supply plan.** Not architectural, still the top risk to the product.                                                                                                                       | Launch            | Hand-recruit 10–20 experts on scheduled on-call shifts. No matching engine can match against an empty pool, and the heartbeat work in Phase 4 makes coverage measurable from day one.                                                 |

**Assumed unless you object:** expert vetting is manual admin review in V1 (`ExpertSkill.verified` already supports assessments later); currency is INR-primary; the dispute window is 7 days.

---

## Closing

The three additions you made are the ones I'd keep if I could only keep three. **Heartbeat** closes a hole that would have produced mysterious 15-minute failures with no diagnostic trail. **The primary-skill floor** converts your brand promise from a scoring preference into an invariant. **Early admin override** means the first bad week is recoverable in minutes instead of becoming a refund and a lost customer.

And the trim is right. It's easy to write a beautiful accounting subsystem for an expert who hasn't signed up yet.

**Awaiting your go-ahead for Phase 1.** Q2 would be useful to have before Phase 3; nothing blocks starting. I'll stop at every phase gate with the summary §40 asks for, and I won't change anything agreed here without asking first.
