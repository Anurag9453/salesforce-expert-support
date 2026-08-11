# Pre-Route launch path — findings and decision tree

**Status: research. Nothing implemented. No provider contracted.**

Narrow question: what can an India-based marketplace use to process its **first
transaction**, before it meets Razorpay Route's turnover requirement?

Classifications: **VERIFIED** (quoted from current official docs) · **REQUIRES PROVIDER
CONFIRMATION** · **REQUIRES CA/LAWYER CONFIRMATION**.

---

## 1. Cashfree Easy Split — no turnover gate is documented anywhere

I reached Cashfree's docs this time via their machine-readable index
(`cashfree.com/docs/llms.txt`) after five blocked attempts at the marketing pages.

### Activation requirements — VERIFIED

> _"a Cashfree Payments account is set up with one of the following collections products:
> Payment Gateway, Payment Links/Forms, Subscriptions"_ … to activate, _"contact your
> account manager."_

**That is the entire documented eligibility condition.** No minimum turnover, no revenue
floor, no company-age condition, no GST or financial-history requirement appears in the
overview, the features page, or the FAQ.

Compare Razorpay Route, **VERIFIED**:

> _"Your business must have domestic turnover exceeding ₹40 Lakhs or export turnover
> exceeding ₹5 Lakhs…"_

⚠️ **REQUIRES DIRECT CONFIRMATION.** Absence of a documented gate is not proof there is no
gate — commercial underwriting often lives outside public docs, and "contact your account
manager" is where an undocumented condition would surface. But on published documentation,
Cashfree has no barrier and Razorpay has an explicit one.

### And the mechanics are better documented than Route's — all VERIFIED

| Requirement                            | Cashfree Easy Split                                                                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixed-amount **and** percentage splits | _"Split by Amount"_ and _"Split by Percentage"_ are both supported                                                                                    |
| Split **after** payment                | _"allows to initiation of split after successful confirmation of payment by the customer"_                                                            |
| Window to perform the split            | _"within 2 days (can be extended further if required)"_                                                                                               |
| Deferred payout                        | Deferred Settlement lets you _"assign a settlement eligibility date for an order and vendor combination"_; delays at **order level and vendor level** |
| Refund after split                     | _"The refund will be done from your and vendor's settlement account according to the respective transaction split created"_                           |
| Freelancer KYC                         | **PAN** + address proof — _"Any one of (Aadhar, Driving License, passport and Voter ID)"_                                                             |
| FX lock                                | IPG offers _"locked-in rates"_; customer pays own currency, merchant _"settle in INR"_                                                                |

Four of those map **exactly** onto requirements that were unresolved for Route:

- "Settlement eligibility date per order and vendor" is precisely your 3–4 day hold — and
  Route's maximum hold period is still undocumented.
- Refunds clawing back proportionally from both accounts is exactly the behaviour §H of the
  architecture doc needed.
- Fixed-amount splits are confirmed, which matters because the processing allowance must be
  excluded from the split base.
- Freelancer KYC is just **PAN + one ID** — a low onboarding barrier for a launch bench.

### The one gap — REQUIRES PROVIDER CONFIRMATION

> Cashfree's International Payment Gateway documentation contains **no mention** of Easy
> Split or split-settlement compatibility.

Same shape of gap as Razorpay, but importantly **not the same finding**: Razorpay
_explicitly says no_, Cashfree _says nothing_. One is a closed door, the other is an
unanswered question.

---

## 2. Razorpay: US card → INR order → Route

Two halves verified separately, **their combination nowhere documented**.

|                                                                | Finding                                                                                | Class                              |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------- |
| Overseas-issued cards accepted                                 | Visa, Mastercard, Amex, Diners, Discover                                               | **VERIFIED**                       |
| Settlement always INR                                          | _"The Settlement currency is INR… for all transactions"_                               | **VERIFIED**                       |
| FX struck at payment creation                                  | _"The exchange rate at the time of the payment creation is considered for conversion"_ | **VERIFIED**                       |
| Route accepts INR orders                                       | INR-only by design                                                                     | **VERIFIED**                       |
| Route on foreign-currency orders                               | _"you cannot create transfers on an order for international currencies"_               | **NOT SUPPORTED**                  |
| **An INR order paid by a US-issued card being Route-eligible** | **not stated anywhere**                                                                | **REQUIRES PROVIDER CONFIRMATION** |

I will not infer it. The currency rule is about the _order_, and an INR order satisfies it
on a plain reading — but Route's eligibility could equally be scoped to domestic
_payments_, and no document distinguishes the two. This is a one-line question for their
support team and it is the whole of Option A.

**It is also moot for launch**, because the turnover gate blocks Route regardless of the
answer.

---

## 3. Compliant pre-Route options

|                                               | Viability                                                                                                                                                                                          |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Cashfree Easy Split**                    | **Strongest.** No documented gate; mechanics verified in detail. REQUIRES DIRECT CONFIRMATION of underwriting.                                                                                     |
| **B. Another licensed provider**              | PayU, PhonePe PG, Instamojo, Juspay all have marketplace/split offerings. **All UNVERIFIED** — I did not research them, because A answers the question if it holds.                                |
| **C. Startup-specific marketplace product**   | None found. Cashfree's low documented bar is the closest thing.                                                                                                                                    |
| **D. Escrow-as-a-service**                    | A genuinely different category — Indian providers (e.g. Castler, Escrowpay) operate bank-backed escrow for marketplaces. **UNVERIFIED**, and worth naming only as a fallback if A and B both fail. |
| ~~Funds to our own account, we disburse~~     | This is payment aggregation. Ruled out, as you instructed.                                                                                                                                         |
| ~~Our own escrow/wallet~~                     | Regulated activity. Ruled out.                                                                                                                                                                     |
| ~~Relabel as principal to bypass regulation~~ | See below.                                                                                                                                                                                         |

### On the principal model, stated honestly rather than as a workaround

The principal structure needs no split product at all, because the money is the platform's
revenue and the freelancer is a supplier being paid. That is why it has no turnover gate
and no aggregation question — it is a normal business, not a payment intermediary.

If Cashfree's underwriting turns out to block you, that is the only structure I know of
that lets you transact on day one. **But adopting it would be a deliberate change to your
commercial and legal model** — different contracts, different invoicing, different GST
treatment (and it removes TDS s.194-O and GST TCS) — and it must be signed off by a CA and
a lawyer as a _business decision_, not implemented as a technical convenience.
**REQUIRES CA/LAWYER CONFIRMATION.** I am not recommending it; I am recording that it
exists and what it would cost.

---

## 4. Decision tree

### 1 · If Cashfree has no turnover gate → the exact flow

```
  Cashfree Payment Gateway  (collections product — the activation prerequisite)
        └─ Easy Split activated via account manager
             └─ freelancers onboarded as VENDORS  (PAN + one address proof)
                  ↓
  customer pays an INR order
        └─ split created AFTER payment confirmation      ← VERIFIED capability
             ├─ 90%  → freelancer vendor account
             └─ 10%  → platform account
                  ↓
  Deferred Settlement: eligibility date = payment + 3–4 days   ← VERIFIED capability
                  ↓
  vendor settlement → freelancer's Indian bank account (INR)
```

Launch the **India corridor** on this immediately. Every step above is verified in
Cashfree's own documentation. The **US corridor** waits on one question: does Easy Split
work with IPG orders?

### 2 · If Cashfree also has a gate

In order: ask **PayU / PhonePe / Instamojo** the single eligibility question (option B) →
then **escrow-as-a-service** (option D) → then, and only as an explicit board-level
decision with professional sign-off, reconsider the commercial structure.

### 3 · If Razorpay confirms US cards can pay INR Route orders

It changes nothing about launch — the turnover gate still applies. It becomes relevant
**after** you clear ₹5 lakh export or ₹40 lakh domestic turnover, at which point Razorpay
becomes a viable second option and you could migrate or dual-run.

This is exactly what the `PaymentGateway` / `PayoutProvider` port separation was for: a
second provider is a composition-root change, not a rewrite. **Build on Cashfree now
without foreclosing Razorpay later.**

### 4 · The exact blocker preventing launch today

Not the code. Not the architecture. Not even the provider choice.

> **No licensed marketplace payment product is activated on any account you hold.**

Concretely, three steps, none of which are engineering:

1. Open a Cashfree account and enable a collections product (Payment Gateway).
2. Ask the account manager to activate **Easy Split**, and confirm there is no turnover or
   vintage requirement.
3. In the same conversation, ask whether **Easy Split works with IPG** (international)
   orders — that single answer decides whether the US corridor launches with India or later.

Behind those sit two **REQUIRES CA/LAWYER CONFIRMATION** items that gate going live but not
building: whether TDS s.194-O and GST TCS apply, and who withholds them.

---

## 5. What this means for the next engineering step

The India corridor is now fully specified by verified provider capabilities, so the
provider-agnostic work is safe to build:

1. The 90/10 split in the customer's currency, with the processing allowance excluded from
   the base. Pure domain, no provider.
2. `ExpertPayable` accrual with a `releaseAt` clock — which maps directly onto Cashfree's
   _"settlement eligibility date"_.
3. The append-only ledger.

None of that depends on which provider wins, and all of it is needed either way.

**The Stripe adapter I wrote earlier should be reverted or left unwired** — on this
evidence Stripe is not a candidate for the India marketplace flow.
