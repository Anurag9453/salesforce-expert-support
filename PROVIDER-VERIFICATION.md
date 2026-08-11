# Provider feasibility — final research

**Status: research complete. No provider selected. Nothing implemented.**

Every finding is classified:

- **VERIFIED** — quoted from current official provider documentation.
- **REQUIRES PROVIDER CONFIRMATION** — documentation missing, ambiguous, or the two facts
  exist separately but their _combination_ is undocumented.
- **NOT SUPPORTED** — documentation explicitly rules it out.

No finding below is inferred from "they support X and they support Y, therefore X+Y".

---

## 1. Two findings that decide the launch architecture

### 1.1 Route has a hard turnover gate — a pre-revenue startup does not qualify

**VERIFIED**, Razorpay Route FAQs:

> _"Your business must have domestic turnover exceeding ₹40 Lakhs or export turnover
> exceeding ₹5 Lakhs in either the current (FY26) or preceding (FY25) financial year."_

Accepted evidence, **VERIFIED**:

> _"GST-3B returns for domestic turnover"_ and _"Bank-issued FIRC (Foreign Inward
> Remittance Certificate) for export turnover."_

**Route is therefore not available to you at launch.** This is a bigger constraint than
the currency limitation, and nothing in the previous three documents anticipated it.

Note the asymmetry: **₹5 lakh export** (~$6,000) versus **₹40 lakh domestic** (~$48,000).
Serving US customers gets you Route-eligible roughly **eight times faster**, and an
INR-denominated sale to a US customer still arrives as foreign inward remittance, so it
should still earn the FIRC evidence Razorpay asks for (**REQUIRES CONFIRMATION** — that
INR-denominated foreign receipts count as export turnover for this test).

### 1.2 The FX rate is struck at payment creation, not at settlement — your lock works

**VERIFIED**, Razorpay international-payments FAQs:

> _"The Settlement currency is INR (Indian rupees) for all transactions made using
> Razorpay. Thus, international payments are settled in INR. **The exchange rate at the
> time of the payment creation is considered for conversion.**"_

This resolves the conflict I raised last round. The INR value of a USD payment is
determinable **at payment creation**, so:

- Your step 2→4 (confirm payment, then lock INR entitlements) works as written.
- There is no T+2 wait before locking.
- The 3–4 day payout clock can start at payment confirmation.

I was wrong to assume settlement-time conversion. Withdrawn.

---

## 2. The bootstrapping problem

Put 1.1 together with your constraints and there is a genuine catch-22:

```
  Route needs ₹5L export / ₹40L domestic turnover
        ↑                                    │
        │                                    ▼
  turnover needs a way to transact  ←  which needs Route
```

Before Route, the compliant ways to transact are narrow:

| Path                                                        | Viable?                                                     |
| ----------------------------------------------------------- | ----------------------------------------------------------- |
| Standard gateway, funds settle to our account, we disburse  | **This is aggregation.** Ruled out.                         |
| Principal model (we sell, freelancer invoices us as vendor) | Compliant, needs no split product — **but you rejected it** |
| A marketplace provider with no turnover gate                | **Unknown** — this is the decisive Cashfree question        |
| Very low volume handled manually while turnover accrues     | Workable for the first handful only                         |

**This is the question to resolve before anything else**, and it is commercial/legal rather
than technical. It is also the strongest argument yet for launching India-only _or_ for
revisiting the principal model as a temporary structure — not because marketplace is
wrong, but because Route is unavailable until you have revenue.

---

## 3. Razorpay — requirement by requirement

| #   | Question                                                               | Finding                                                                                                                                                                                   | Class                                                          |
| --- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| R1  | US customer, US card, pays an **INR-denominated** order                | Overseas-bank cards supported across Visa/MC/Amex/Diners/Discover; settlement always INR. Whether an INR-denominated order can be paid by an overseas card **specifically** is not stated | **REQUIRES CONFIRMATION**                                      |
| R2  | That INR order then works with Route (90/10, linked account, deferred) | Route is INR-only, so the order currency is right — but no document states international-card payments are Route-eligible                                                                 | **REQUIRES CONFIRMATION** ← _the decisive question_            |
| R3a | Fee for a US card paying an INR order                                  | International card: _"up to 3%"_ + 18% GST                                                                                                                                                | **VERIFIED** (ceiling, not a quote)                            |
| R3b | Treated as international?                                              | Yes, by card issuance not by currency                                                                                                                                                     | **VERIFIED**                                                   |
| R3c | Who converts?                                                          | If the order is INR, Razorpay states _"No currency conversion is required"_ for native-currency amounts — the issuing bank converts                                                       | **VERIFIED (principle)**                                       |
| R3d | Settled entirely in INR to us?                                         | _"The Settlement currency is INR… for all transactions"_                                                                                                                                  | **VERIFIED**                                                   |
| R4  | Route eligibility for pre-revenue                                      | ₹40L domestic / ₹5L export turnover required                                                                                                                                              | **NOT SUPPORTED for pre-revenue**                              |
| R5a | Transfers created **after** payment                                    | _"You should initiate Transfer using Payments when information regarding payment split is decided post customer transaction"_                                                             | **VERIFIED**                                                   |
| R5b | Deferred / delayed transfer                                            | _"Defer the transfer settlement"_, _"Define a custom delay period for settlement"_                                                                                                        | **VERIFIED**                                                   |
| R5c | Maximum hold period — is 3–4 days inside it?                           | Not documented                                                                                                                                                                            | **REQUIRES CONFIRMATION**                                      |
| R5d | Fixed-amount vs percentage transfers                                   | Not documented on the pages reachable                                                                                                                                                     | **REQUIRES CONFIRMATION**                                      |
| R5e | Refund after a transfer exists                                         | _"You can also refund payment and simultaneously reverse all the transfers made on that payment"_                                                                                         | **VERIFIED**                                                   |
| R5f | Reversal after freelancer payout has left                              | Not documented                                                                                                                                                                            | **REQUIRES CONFIRMATION**                                      |
| R6  | Route on **foreign-currency** orders                                   | _"Currently, we support only INR for Razorpay Route"_; _"you cannot create transfers on an order for international currencies"_                                                           | **NOT SUPPORTED**                                              |
| R7  | Marketplace model fit                                                  | Route requires _"the linked account… directly interfaces with those customers to provide goods or services"_                                                                              | **VERIFIED — and it confirms your model is what Route is for** |
| R8  | Webhooks for reconciliation                                            | `transfer.processed`, `transfer.failed`, `settlement.processed`                                                                                                                           | **VERIFIED**                                                   |
| R9  | TDS s.194-O / GST TCS withheld by Razorpay?                            | Not documented                                                                                                                                                                            | **REQUIRES CONFIRMATION**                                      |

**R7 is quietly reassuring**: Route's own eligibility condition describes precisely the
intermediary relationship you specified. The commercial model and the product are aligned;
only the turnover gate and the currency rule stand in the way.

---

## 4. Cashfree — I could not verify anything

Every route I tried was blocked: `cashfree.com/pricing` **403**,
`docs.cashfree.com/docs/easy-split-introduction` **301→404**,
`cashfree.com/easy-split` **403**, `cashfree.com/docs/reference/easy-split-overview` **404**,
`cashfree.com/docs/payments/online/split-settlements` **404**.

**Everything about Cashfree is therefore REQUIRES PROVIDER CONFIRMATION.** I will not
guess, and I would rather report the gap than fill it with plausible-sounding claims.

The questions that matter, in order — because Cashfree is only interesting if it beats
Razorpay on one of the two blockers:

1. **Is there a minimum turnover requirement for Easy Split?** If not, Cashfree wins
   outright on §2 regardless of anything else.
2. **Does Easy Split support foreign-currency orders?** If yes, it solves what Route
   explicitly cannot.
3. Deferred vendor settlement, and the maximum period.
4. Whether Global Collections (their cross-border product) composes with Easy Split — the
   same "two features separately ≠ together" trap as R2.
5. Fees: domestic, international, FX markup, split fee, payout fee, GST.
6. Vendor KYC fields and timeline.

---

## 5. The four options compared

|                         | **A** Razorpay, INR orders both corridors                   | **B** Razorpay India + other for USA                             | **C** Cashfree (or other) single provider | **D** India-only first                                        |
| ----------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------- |
| **Customer UX**         | Poor for US — sees ₹1,760, plus their bank's ~3% FX fee     | Best — each corridor in its native currency                      | Best, if it supports USD                  | India: ideal. US: none yet                                    |
| **Implementation**      | Simplest — one integration, one currency, no FX code        | Worst — two integrations, two reconciliations, two KYC pipelines | Simple if it works                        | Simplest of all                                               |
| **Regulatory**          | Low — INR-only, no PA-CB question, no FEMA conversion issue | High — PA-CB for the USD corridor, plus two providers            | Medium — PA-CB still applies to USD       | Lowest                                                        |
| **Payment cost**        | ~3.54% (international card on INR order)                    | ~3.54% + second provider's fees                                  | Unknown                                   | ~2.36% domestic only                                          |
| **Freelancer payout**   | Identical everywhere: INR, exact, no FX                     | Identical, but reconciled from two sources                       | Identical                                 | Identical                                                     |
| **Startup eligibility** | **Blocked** until ₹5L export / ₹40L domestic                | **Blocked** on the Razorpay half                                 | **Unknown — the decisive question**       | **Blocked** on the ₹40L domestic test (8× harder than export) |
| **Preserves 10/90**     | ✔ fully — no FX, so nothing erodes it                       | ✔ but FX variance must be handled per corridor                   | ✔ if fixed-amount splits exist            | ✔ fully                                                       |

### The uncomfortable observation

**Option D is the _worst_ on startup eligibility, not the best.** India-only revenue must
reach **₹40 lakh** to unlock Route, whereas export revenue only needs **₹5 lakh**. Serving
US customers is the faster path to Route eligibility — the opposite of what I recommended
in the previous two documents on margin and regulatory grounds.

That does not automatically make D wrong; it means the sequencing argument is now
genuinely two-sided rather than obvious.

---

## 6. Recommendation

**Option A**, conditional on two confirmations — but the turnover gate must be solved first
and it is not a technical problem.

Why A, on current evidence:

- It is the only option where **every one of your requirements is either verified or
  reduces to a single yes/no question** (R1+R2).
- It removes FX from the system entirely: INR order, INR settlement, INR entitlement. Your
  lock requirement becomes trivial rather than carefully engineered.
- The expert sees an **exact** INR figure before accepting — impossible under any
  USD-denominated design, given they commit two steps before payment.
- One integration, one currency, one reconciliation.
- It reaches Route eligibility fastest, via the ₹5 lakh export threshold.

Its one real cost — US customers seeing rupees — is a conversion question you can measure,
not a structural flaw.

### The three things to confirm, in strict order

1. **Cashfree: is there a turnover gate on Easy Split?** If no, Cashfree likely wins on
   §2 and this comparison reopens.
2. **Razorpay R2: can an overseas card pay an INR order, and is that payment Route-eligible?**
   One question, and it is the whole of Option A.
3. **How do you transact compliantly before Route is available?** Commercial/legal, and
   the actual launch blocker.

Until 3 has an answer, no provider choice unblocks a launch.

---

## 7. Corrections to my earlier documents

Three, stated plainly:

- I recommended "a single India-authorised PA with a marketplace product" without checking
  eligibility. **Route requires ₹40L domestic or ₹5L export turnover** — the recommendation
  was unbuildable for a pre-revenue company.
- I assumed FX conversion happens at settlement. Razorpay states it is struck **at payment
  creation**. Your lock design was right and my objection was wrong.
- I argued India-first on margin and regulatory simplicity. On **Route eligibility** it is
  the slower path — ₹40L versus ₹5L. The argument is now balanced, not one-sided.
