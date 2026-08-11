# Unit economics — customer-paid processing fee

**Status: proposal. Not implemented.** Companion to `PAYMENTS-ARCHITECTURE.md`.

Model: `session price + processing fee = customer total`. The 10% commission and the 90%
freelancer entitlement are both computed on the **session price**, never on the total,
and neither is reduced by processing costs.

---

## 1. The blocking question: is a separate fee even permitted?

You asked me to determine this rather than assume it. I could not verify it from an
authoritative source — RBI's site returned an unrelated document and Cashfree's pricing
page refused the request. So the following is my understanding, flagged as **needing a
lawyer**, and it is the single thing that decides whether this design is buildable as
described.

**India — likely prohibited for the methods that matter.**

- RBI has restricted merchant **surcharging on debit cards**.
- **UPI carries zero MDR by RBI mandate.** Razorpay's 2% on UPI is its own platform fee,
  not an interchange cost — so passing it to the customer as a "processing fee" is
  arguably not a surcharge at all, but it is also not obviously permitted. This needs a
  direct answer.
- Card network rules independently restrict surcharging.

**USA — permitted but conditional.** Capped at your cost of acceptance, requires
registration with the card networks in advance, generally **credit cards only**, and
prohibited in a small number of states.

> **This is the same conclusion I reached earlier in the project**, when you chose to
> build the cost into the price instead. That decision was sound. Reversing it to a
> visible line item reopens three regulatory regimes at once.

### The alternative that achieves identical economics and is legal everywhere

**Corridor-specific pricing.** Set the US price higher than the India price because the
cost of serving a US customer is higher — and present it as the price, not as a fee.

```
  India:  ₹1,700          (2.36% cost)
  USA:    $20.73          (3.54%+ cost)
```

A price is a price in every jurisdiction. There is no cap, no registration, no
state-by-state analysis, and no debit/credit distinction. It also converts better —
people abandon at a fee appearing late, not at a price they already agreed.

Mechanically it is what the codebase already does: `processingAllowanceCents` splits the
price into a base and an allowance. §5 shows it protects the 90/10 identically.

**My recommendation is corridor pricing.** But the economics below work either way — only
the presentation differs.

---

## 2. Verified provider fees (Razorpay, from their pricing page)

|                                                | Fee          | GST             | Effective                             |
| ---------------------------------------------- | ------------ | --------------- | ------------------------------------- |
| **Domestic** (cards, UPI, netbanking, wallets) | **2%**       | +18% on the fee | **2.36%**                             |
| **International cards**                        | **up to 3%** | +18% on the fee | **3.54%**                             |
| International bank transfer (SWIFT/ACH)        | 1%           | +18%            | 1.18%, **live rate, no forex markup** |

Three findings that matter:

**There is no fixed per-transaction fee.** Unlike Stripe US (2.9% + $0.30), Razorpay is
purely percentage-based in India. This removes the problem I flagged earlier where a flat
30¢ consumed 44% of the take on a $20 session. **Small tickets are viable.** On $20,
Razorpay international costs ~$0.71 where Stripe US would cost $0.88.

**Settlement is always INR** for an Indian business, confirmed in Razorpay's docs. So
conversion always happens on a US sale; the only question is the rate and markup.

**GST on the fee is probably recoverable.** If the platform is GST-registered, the 18% on
provider fees should be input tax credit — meaning the true cost is **2%, not 2.36%**.
If so, grossing the customer up for GST **overcharges them**. Must be confirmed with a
CA; the model below shows both.

### Not verified

- Whether the international 3% **includes** the forex markup or it is charged separately.
  This is the largest single unknown — it is the difference between 3.54% and ~5.5%.
- Cashfree's schedule (their page returned 403).
- Razorpay Route / Easy Split marketplace fees, if any, on top of the gateway fee.
- Refund and chargeback fees.

---

## 3. The arithmetic that is easy to get wrong

The provider charges its percentage on **the total the customer pays, including the
fee**. So a naive `fee = rate × price` under-recovers, permanently.

The correct gross-up:

```
                rate × price  +  fixed
   fee   =   ─────────────────────────
                    1 − rate
```

At 3.54% on a $20 session: naive gives $0.71, correct gives **$0.73**. Small here, and
it compounds at every transaction forever.

---

## 4. Worked economics

Assumptions, all flagged: 1 USD = ₹85; Razorpay domestic 2.36%, international 3.54%
(FX markup unconfirmed — a second column shows 5.54% if it is separate); TDS s.194-O at
1%; GST on provider fees treated as a **cost** here, though it may be reclaimable.

The INR session price is an independently chosen number, not a conversion. ₹1,700 is used
as a stand-in and **needs to be chosen by you**.

### 4.1 India customer → Indian freelancer

```
  Session price                          ₹1,700
  Processing fee  (2.36% grossed up)        ₹41
  ─────────────────────────────────────────────
  Customer total                         ₹1,741

  Provider fee   2.36% of ₹1,741            ₹41      ← exactly recovered
  Settled to escrow                      ₹1,700

  Platform commission  10% of ₹1,700       ₹170
  Freelancer share     90% of ₹1,700     ₹1,530
    less TDS 1%                            ₹15
  Freelancer receives                    ₹1,515

  Platform net                             ₹170     (10.0% — fully protected)
  FX impact                                none
```

If GST on the fee is reclaimable, the fee is **₹35** and the customer total **₹1,735**.

### 4.2 US customer → Indian freelancer, $20 session

```
                                  3.54%        5.54% (if FX markup separate)
  Session price                   $20.00       $20.00
  Processing fee (grossed up)      $0.73        $1.17
  Customer total                  $20.73       $21.17

  Platform commission  10%         $2.00        $2.00
  Freelancer share     90%        $18.00       $18.00

  ── settlement, at ₹85 ──
  Gross converted               ₹1,762.05    ₹1,799.45
  Provider fee                     −₹62.38     −₹99.69
  Net into escrow                ₹1,699.67    ₹1,699.76   ≈ ₹1,700 either way

  Platform                          ₹170         ₹170
  Freelancer gross                ₹1,530       ₹1,530
    less TDS 1%                      ₹15          ₹15
  Freelancer receives             ₹1,515       ₹1,515
```

**The fee recovers the cost exactly in both cases** — the customer simply pays $0.44 more
under the worse assumption. Neither the platform's ₹170 nor the freelancer's ₹1,530 moves.
That is the design working.

### 4.3 US customer, $35 session

```
  Session price                   $35.00
  Processing fee                   $1.28   ($2.05 at 5.54%)
  Customer total                  $36.28   ($37.05)

  Platform commission  10%         $3.50   →  ₹297.50
  Freelancer share     90%        $31.50   →  ₹2,677.50
    less TDS 1%                              ₹26.78
  Freelancer receives                      ₹2,650.72
```

### 4.4 US customer, $50 session

```
  Session price                   $50.00
  Processing fee                   $1.84   ($2.93 at 5.54%)
  Customer total                  $51.84   ($52.93)

  Platform commission  10%         $5.00   →  ₹425.00
  Freelancer share     90%        $45.00   →  ₹3,825.00
    less TDS 1%                              ₹38.25
  Freelancer receives                      ₹3,786.75
```

### 4.5 Summary

|        | Session | Fee   | Customer total | Platform        | Freelancer (₹, post-TDS) |
| ------ | ------- | ----- | -------------- | --------------- | ------------------------ |
| India  | ₹1,700  | ₹41   | **₹1,741**     | ₹170            | ₹1,515                   |
| US $20 | $20     | $0.73 | **$20.73**     | $2.00 → ₹170    | ₹1,515                   |
| US $35 | $35     | $1.28 | **$36.28**     | $3.50 → ₹297.50 | ₹2,651                   |
| US $50 | $50     | $1.84 | **$51.84**     | $5.00 → ₹425    | ₹3,787                   |

**The platform keeps a clean 10% on every row.** That is the point of the change, and it
holds.

---

## 5. Two consequences for the architecture

### 5.1 A percentage split no longer works

If the customer pays $20.73 and the provider performs a 90/10 **percentage** split, the
freelancer receives 90% of $20.73 = $18.66 — not $18. The processing fee would be shared
with the freelancer, which is exactly what you said must not happen.

So the split must be **fixed-amount**, or computed on a base that excludes the fee.
This reverses the "percentage splits fit natively" advantage I claimed last round.
Razorpay Route supports both modes, so it is workable — but it changes which mode we use,
and it must be confirmed for **cross-border** settlements specifically, where the INR
amount is not known until conversion.

### 5.2 FX incidence is still undecided

Processing fees are now the customer's. **FX movement is not addressed.** The freelancer's
$18 becomes ₹1,530 at _some_ rate, and rates move between accept and payout.

You have said the UI must show the freelancer their expected earning **before** they
accept. That is only strictly truthful if the INR figure is locked at that moment — which
means the platform absorbs rate movement out of its ₹170. A 2% adverse move on ₹1,530 is
₹30, or 18% of the commission on that session.

The alternative is to show "≈ ₹1,530" and settle at the actual rate, which is honest but
weaker. **This needs your decision.**

---

## 6. What must be confirmed before the architecture is locked

**Lawyer / CA**

1. **Can a separate customer-facing processing fee be charged in India?** For UPI, debit,
   and credit — they may differ. This decides §1.
2. Same question for US customers, including network registration and state restrictions.
3. Is GST on provider fees recoverable as input tax credit? If yes, do not gross up for it.
4. Is the processing fee itself a taxable supply attracting GST on our invoice?
5. TDS s.194-O: on the session price or the customer total? (I have assumed session price.)

**Razorpay / Cashfree**

6. **Does the international 3% include the forex markup, or is it separate?** Largest
   single unknown in the model.
7. Does the provider fee apply to the session price or the total including our fee?
   (I have assumed the total — see §3.)
8. Are **fixed-amount** splits supported on cross-border settlements, not just domestic?
9. Any Route / Easy Split fee on top of the gateway fee?
10. Refund fee, chargeback fee, and who bears them.
11. Is the exchange rate struck at authorisation, capture, or settlement?
12. Confirm the actual international card rate for our account — "up to 3%" is a ceiling,
    not a quote.

**Decisions for you**

13. Separate fee, or corridor pricing? (§1 — I recommend corridor pricing.)
14. Who bears FX between accept and payout? (§5.2)
15. The INR session prices. ₹1,700 is a placeholder; per the no-FX rule these are chosen,
    not converted.

---

## 7. UI requirements arising

**Customer, before payment** — session price and processing fee as separate lines, then
the total. If corridor pricing is chosen instead, one price and no fee line.

**Freelancer, before accepting** — the INR figure, and whether it is exact or approximate
must match the §5.2 decision. The offer panel already shows a payout figure; it currently
derives from the customer price and will need to read the new field.
