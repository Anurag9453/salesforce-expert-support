# Payment architecture — marketplace model, 90/10 split (revised)

**Status: proposed, not built. Awaiting approval.**
Supersedes both earlier drafts (principal model, and independent-INR-rate-card model).

Scope: India-based marketplace. Customers in 🇺🇸 USA and 🇮🇳 India. Freelancers in 🇮🇳
India only. **Platform commission = 10% of the customer transaction price; freelancer
share = 90%.** Payouts ~3–4 days after release. The platform does not become a payment
aggregator.

> Nothing here is legal advice, and calling something a "marketplace" decides nothing.
> §K lists what must be confirmed with an Indian CA, a lawyer, and the provider.

---

## 0. The commission model, and the one question it leaves open

### 0.1 The split is defined in the customer's currency, at transaction time

```
  Indian customer pays  ₹10,000     →  platform ₹1,000   freelancer ₹9,000
  US customer pays        $100      →  platform    $10    freelancer    $90
```

Both shares are denominated in **the currency the customer paid in**, fixed the moment
the transaction is priced. The freelancer's 90% is a _claim_, which for a US sale is
USD-denominated and must later be settled in INR.

The previous draft had this wrong, and my "commission can go negative" warning was an
artefact of that error. **Withdrawn** — a percentage of the transaction cannot go
negative.

### 0.2 What replaces it: fee and FX incidence

Two costs arrive _after_ the 90/10 split is agreed, and the model does not yet say who
carries them:

1. **Provider fees.** ~2% domestic, but up to ~6.3% cross-border once the international
   card rate and the ~2% conversion spread are both applied.
2. **FX movement** between the moment the freelancer is promised their share and the
   moment INR actually lands in their bank account — days later.

"Platform takes 10%, freelancer takes 90%" is silent on both. Three coherent answers:

|                                                | Freelancer receives           | Who bears fees | Who bears FX                       |
| ---------------------------------------------- | ----------------------------- | -------------- | ---------------------------------- |
| **(a) Split the gross; platform absorbs fees** | 90% of gross                  | platform       | platform (if INR locked at accept) |
| **(b) Fees off the top, then split**           | 90% of net                    | both, pro-rata | shared                             |
| **(c) Split gross; convert at payout**         | 90%, at whatever rate applies | platform       | **freelancer**                     |

This is not a detail. On a $100 cross-border sale the gap between (a) and (b) is about
**₹500 in the freelancer's pocket** — see the worked example in §G.

**My recommendation is (a)**, for a reason that is already baked into the product: the
offer panel shows an expert _"You earn ₹x"_ before they accept. That promise cannot be
made under (c), where the number is unknown until settlement, and is misleading under
(b), where fees vary by the customer's card. Under (a) the number is knowable and stable,
and the platform absorbs variance — which is the same rule we have applied everywhere
else.

### 0.3 The 10% is thinner than it looks on cross-border

Under (a), the platform's 10% is what absorbs the provider's fees:

| Corridor      | Commission | Provider fees | **Platform net** |
| ------------- | ---------- | ------------- | ---------------- |
| India → India | 10.0%      | ~2.0%         | **~8.0%**        |
| US → India    | 10.0%      | ~6.3%         | **~3.7%**        |

Both positive, so nothing is structurally broken. But a US sale earns you **less than
half** what an Indian sale of equal value does, and if cross-border fees ever exceed 10%
the corridor is loss-making. Worth knowing before the US corridor becomes the growth
story. **It is also an argument for sequencing India first** (§L).

### 0.4 Unchanged from the previous draft, and still the regulatory crux

In a genuine intermediary model the customer's payment is consideration for the
_freelancer's_ service. Collecting it into the platform's own account and disbursing
later is **payment aggregation**, requiring RBI authorisation — the thing you said you
do not want to do.

> **Marketplace funds must sit in a licensed provider's escrow/nodal account, never in
> the platform's own bank account.**

Also unchanged: choosing marketplace brings **TDS s.194-O** (~1% withholding on
freelancer payments) and **GST TCS s.52** (~1%), with monthly filings. A principal model
would have neither. Both need CA confirmation (§K).

### 0.5 Good news: a percentage split fits the provider products natively

This is a real advantage of the 90/10 model over the fixed-INR one I proposed before.
Razorpay Route and Cashfree Easy Split both support **percentage splits**, so the
provider can perform the split itself, in escrow, without us computing INR amounts up
front. The fixed-INR model would have forced every split to be computed after settlement.

---

## A. Marketplace money flow

```
  ┌──────────┐  ₹10,000 or $100   ┌──────────────────────────┐
  │ Customer │ ─────────────────▶ │  Licensed PA             │
  └──────────┘                    │  escrow / nodal account  │
                                  │  (NOT our bank account)  │
                                  └────────────┬─────────────┘
                                               │  90 / 10 split
                          held ~3–4 days after release
                                               │
                    ┌──────────────────────────┴──────────────┐
                    ▼                                         ▼
        ┌──────────────────────────┐              ┌──────────────────────┐
        │ Freelancer  90%          │              │ Platform  10%        │
        │ paid in INR              │              │ less provider fees   │
        │ less TDS / TCS           │              │ = our net revenue    │
        └──────────────────────────┘              └──────────────────────┘
```

Our application never touches the money. It records intent, instructs the provider, and
mirrors the provider's state. The authoritative balance is the provider's.

---

## B. Payment-provider responsibilities

Card/UPI/netbanking collection (and all PCI scope) · cross-border USD acceptance under
PA-CB · the escrow account · **the 90/10 split itself** · USD→INR conversion and the rate
· freelancer KYC and bank verification · disbursement rails · settlement reports ·
chargeback mechanics.

## C. Application responsibilities

Customer price list per currency · the commission **rate** (10%) and the resulting split
amounts · which freelancer and their agreed share · order/session lifecycle · payable
accrual and the release clock · instructing transfers idempotently · mirroring provider
state via webhooks · the ledger and audit trail · refund _decisions_ · reconciliation
against settlement reports.

We do **not**: hold funds, convert currency, store bank or card details, or decide KYC.

---

## D. Database / schema changes

### D.1 What survives from the current code

**`platformFeeBps` survives** — it is exactly this model, and 10% is `1000`. The recent
work on `splitFee`/`splitSessionPrice` is reusable rather than discarded. That is a
meaningful saving over the previous draft, which would have deleted it.

The **processing allowance** also still fits, and resolves cleanly: it is excluded from
the split base and belongs wholly to the platform.

```
  customer pays          $21.00
  − processing allowance  $1.00   → platform, in full
  = split base           $20.00
      platform 10%        $2.00
      freelancer 90%     $18.00
```

Without the exclusion the freelancer would take 90% of money that exists solely to cover
card processing.

### D.2 `Order` (on `SupportSession`) — the commercial record

```
  customerPriceMinor        Int     what the customer agreed
  customerCurrency          String  USD | INR
  processingAllowanceMinor  Int
  splitBaseMinor            Int     price − allowance
  commissionBps             Int     1000, snapshotted so a rate change is not retroactive
  commissionMinor           Int     10% of split base, in customer currency
  freelancerShareMinor      Int     90% of split base, in customer currency
  freelancerShareCurrency   String
```

Both shares stored **in the customer's currency**, because that is where they were
agreed. The INR figure is a separate, later fact.

### D.3 `ExpertPayable` — the INR entitlement

```
  supportSessionId  @unique      ← one payable per session; DB-enforced idempotency
  sourceAmountMinor Int          the $90, as agreed
  sourceCurrency    String       USD | INR
  fxConversionId    String?      null for INR sales
  grossInrMinor     Int          the ₹ equivalent, locked per §0.2(a)
  tdsMinor          Int          s.194-O
  otherDeductions   Int          usage fee
  netPayableMinor   Int
  status            PayableStatus
  releaseAt         DateTime
  payoutId          String?
```

`sourceAmountMinor` and `grossInrMinor` are **both** kept. One is what was agreed, the
other is what is owed. Collapsing them loses the ability to explain a payout.

### D.4 Also new

- `PaymentFee` — one row per provider fee; they arrive separately and reverse separately.
- `FxConversion` — `rate Decimal(18,8)`, source, timestamp. Money stays integer minor
  units; the rate is the only non-integer, and never a float.
- `Payout` / `PayoutBatch` — `idempotencyKey @unique`.
- `LedgerEntry` — append-only, double-entry. Accounts: `ESCROW`, `EXPERT_PAYABLE`,
  `PLATFORM_COMMISSION`, `PROVIDER_FEE`, `FX_VARIANCE`, `TDS_WITHHELD`, `TCS_COLLECTED`,
  `REFUNDS`.
- `ExpertPayoutAccount` — provider `recipientRef` + masked tail. **Never the full account
  number.**

---

## E. Payment state machine

```
  REQUIRES_METHOD ─▶ AUTHORIZED ─▶ CAPTURED ─▶ SETTLED
        │                │            │          ├─▶ PARTIALLY_REFUNDED
        │                │            │          ├─▶ REFUNDED
        ├─▶ FAILED       └─▶ CANCELLED           └─▶ CHARGEBACK ─▶ CB_WON | CB_LOST
```

`SETTLED` is distinct from `CAPTURED`: captured ≠ money in escrow. Fees and the FX rate
are only known at settlement, so **realised** commission cannot be computed before it.

## F. Freelancer payout state machine

```
  ACCRUED ─▶ HELD ─▶ RELEASED ─▶ PAYING ─▶ PAID
               │       │           ├─▶ FAILED   ─▶ RELEASED (retry)
               │       │           └─▶ RETURNED ─▶ RELEASED (bank bounce, days later)
               └───────┴─▶ ON_HOLD ─▶ CLAWED_BACK
                                 └──▶ RELEASED
```

`releaseAt` is a stored timestamp, not a scheduled job — it survives a worker restart.

---

## G. Commission calculation, worked

### G.1 Indian customer — no FX

```
  Customer pays                    ₹10,000
  Split base                       ₹10,000
    Platform commission  10%        ₹1,000
    Freelancer share     90%        ₹9,000
  Provider fee ~2% (from platform)   −₹200
  ─────────────────────────────────────────
  Platform net                        ₹800     (8.0% of the transaction)
  Freelancer gross                  ₹9,000
    less TDS 1%                       −₹90
  Freelancer receives               ₹8,910
```

### G.2 US customer — the interesting one

Assume 1 USD = ₹88 at transaction time, cross-border fees ≈ 6.3%.

```
  Customer pays                     $100.00
    Platform commission  10%         $10.00
    Freelancer share     90%         $90.00

  ── settlement ───────────────────────────
  Gross converted  $100 × 88        ₹8,800
  Provider fees ~6.3%                −₹554
  Net into escrow                   ₹8,246

  ── recommendation (a): platform absorbs fees ──
  Freelancer  $90 locked at ₹88     ₹7,920
  Platform    residual                ₹326     (3.7% of the transaction)

  ── alternative (b): fees off the top, then split ──
  Freelancer  90% of ₹8,246         ₹7,421
  Platform    10% of ₹8,246           ₹825     (9.4%)
```

**The freelancer is ~₹500 better off under (a); the platform is ~₹500 better off under
(b).** That is the decision in §0.2, in one number.

### G.3 Projected vs realised

Both are recorded. Projected commission is computed at order time from an indicative
rate; realised commission comes from the settlement report. The difference is FX and fee
variance, posted to `FX_VARIANCE` so it is visible rather than buried in a rounding line.

---

## H. Refunds and chargebacks

**Before payout** — the common case, and what the 3–4 day hold exists for. Payable goes
`ON_HOLD → CLAWED_BACK`; the provider refunds the customer in the **presentment
currency**. On a partial refund, the 90/10 split applies to the refunded portion too, so
both sides give back proportionally.

**After payout** — the freelancer has the money. Needs your decision: recover from future
earnings, absorb as platform cost, or pursue.

**Chargebacks** are not refunds: bank-initiated, arriving weeks later, carrying a fee, and
disproportionately cross-border. They need their own state, an evidence workflow, and an
explicit answer on who bears the fee.

---

## I. Currency and FX handling

- Money: **integer minor units, always.** Never floating point.
- The 90/10 split is computed **in the customer's currency**, never after conversion.
- Conversion applies only to the freelancer's _payment_, never to the _split_.
- Recorded on every conversion: rate, source, timestamp, both amounts.
- **The presentment amount is preserved forever** — a refund must return what the
  customer paid, in the currency they paid it.
- Freelancers are shown INR. Their USD-sourced share is stored in both currencies so a
  payout can always be explained back to the transaction that produced it.

---

## J. Webhooks and idempotency

```
  1. Read the RAW body. Any re-encoding breaks the signature.
  2. Verify the signature.  ✗ → 400, terse.
  3. INSERT (provider, externalEventId). Conflict → 200 {duplicate}, stop.
  4. Enqueue a job. Return 200 immediately.
  5. Worker: load, apply a GUARDED transition, write ledger entries, mark processed.
  6. Unknown event type → record, mark processed, 200.
```

Dedup must be a **unique constraint**, not read-then-write. Processing must be
**asynchronous**, or a slow handler causes a timeout, which causes a retry, which causes
the pile-up you were avoiding. Every mutating provider call carries an idempotency key
derived from our own row id. **The frontend never confirms payment.**

Steps 1–3 exist and are verified against signed payloads. 4–6 do not.

---

## K. What must be confirmed externally

**CA / lawyer** — intermediary vs principal treatment · **TDS s.194-O** applicability,
rate, PAN-absent rate · **GST TCS s.52** · GST on commission and place-of-supply for a US
customer (is the commission an export of services?) · whether the freelancer's supply
falls under s.9(5) notified services · FEMA treatment of USD receipts (FIRC/eBRC, purpose
codes) · whether our terms may state customer↔freelancer contracting.

**RBI / regulatory** — **PA-CB authorisation**: which providers hold it today for our use
case · confirmation that this design keeps us outside PA authorisation entirely.

**Provider** — does the split apply to **gross or net of fees**? (this decides §0.2 in
practice) · are percentage splits supported on **cross-border** settlements, not just
domestic? · can a split be held 3–4 days natively? · what rate is used for USD→INR and
when is it struck? · freelancer KYC fields and timeline · payout rails, cut-offs, limits,
return semantics · do they withhold TDS/TCS, or do we compute and they transfer net? ·
do test-mode payouts exist?

---

## L. Recommended V1 architecture

|                                          | Domestic INR    | Cross-border USD          | % split               | Payouts                                     | Single vendor  |
| ---------------------------------------- | --------------- | ------------------------- | --------------------- | ------------------------------------------- | -------------- |
| **Razorpay (Payments + Route)**          | strong          | supported, needs approval | ✔ Route               | Route / RazorpayX                           | ✔              |
| **Cashfree (PG + Easy Split + Payouts)** | strong          | Global Collections        | ✔ Easy Split          | own payout licence                          | ✔              |
| **Stripe Connect**                       | weaker in India | best card acceptance      | ✔                     | **India availability is the open question** | ✔ if available |
| **Stripe collect + RazorpayX pay out**   | n/a             | strong                    | ✘ we would hold funds | strong                                      | ✘              |

The last row is the trap: if collection settles into **our** account and we disburse, we
are aggregating.

**Recommendation:** a single India-authorised PA with a native marketplace product
(Razorpay Route or Cashfree Easy Split), provided it supports cross-border collection
under PA-CB. The 90/10 percentage split maps directly onto both products, so the provider
performs the split in escrow and we never compute INR amounts up front.

**Sequence by corridor.** India→India is regulatorily straightforward, has ~8% net margin
versus ~3.7%, and can ship first. US→India follows once PA-CB and the gross-vs-net
question are answered. This gets you live months earlier and on the better-margin
corridor.

I still would not pick Stripe on current information, despite having written an adapter
for it — the India marketplace-payout shape is the open question, and it is the
requirement that matters most.

---

## M. What should NOT be built yet

- Any gateway integration until the provider is chosen. **The Stripe adapter is a spike**
  — leave it unwired or revert it.
- Our own escrow, wallet or balance-holding. That is the regulated activity.
- FX conversion logic. The provider converts; we record what happened.
- Storage of bank or card details.
- Automatic payouts. Manual admin-triggered first.
- Chargeback representment UI. Record the state; handle the first few by hand.

### What I would build first, once approved

1. The split model — commission and freelancer share in the customer's currency, with the
   allowance excluded from the base. Pure domain, provider-agnostic, fully testable, and
   it is mostly an adaptation of `splitSessionPrice` rather than new code.
2. Payable accrual, the release clock, and the ledger.
3. The provider adapter, once chosen.
