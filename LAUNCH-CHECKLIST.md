# Before this is a real public website

The customer path works end to end in production today: land, pick one of four
kinds of help, describe the problem, leave contact details, submit. No account, no
card. That is genuinely done.

This file is what is _not_ done. It exists because the site now looks finished
enough to be mistaken for finished, and several of the gaps below are invisible
from the outside — an expert signup that cannot complete, a rate limiter that
counts per instance, a privacy notice with square brackets in it.

Ordered by what blocks what, not by effort.

---

## 1. Blocks launch — a user journey is broken

### A real mail provider

`MAILER_PROVIDER=mock`. Verification emails are written to a log nobody reads.

**Consequence: no expert can complete signup.** Registration is gated on email
verification, so "Become a Salesforce expert" leads to a door that opens onto a
wall. Customers also get no acknowledgement that their request arrived.

Needs a provider (Resend, Postmark, SES) and a domain to send from.

### A domain you control

Blocks more than it looks like:

- the four `[DOMAIN]` addresses on `/contact` are placeholders
- SPF/DKIM/DMARC cannot be set up, which is why **Salesforce notification emails
  land in spam** — diagnosed: 0 DKIM keys, 0 org-wide addresses, sending as
  `@gmail.com` through Salesforce servers
- `BETTER_AUTH_URL` and `NEXT_PUBLIC_APP_URL` point at a `.vercel.app` URL
- `robots.txt` and a sitemap have nothing to reference

### Legal entity details

`/contact`, `/privacy` and `/terms` all contain `[LEGAL ENTITY NAME]`,
`[JURISDICTION]`, `[REGISTERED ADDRESS]`, `[NUMBER]`. A business collecting names,
emails and phone numbers owes visitors a name and an address they can act against.

### Legal review of the two drafts

`/privacy` and `/terms` carry a visible **"Draft — not yet reviewed"** banner.
That banner is honest, not decorative — delete it when a lawyer has read both and
the placeholders are filled.

Specific things worth their attention:

- the intermediary/marketplace structure, which the terms deliberately describe
  rather than characterise legally
- the prohibition on credentials, production data and PHI
- data stored in **South Korea** (Supabase Seoul) and what that requires by way of
  disclosure and transfer basis
- whether a consent or notice step is required _at the point of collection_ on the
  intake form, which there currently is not

### The worker is not deployed anywhere

pg-boss needs an always-on process. Vercel functions cannot hold a queue open.

Nothing consumes `crm-sync`, so **a submitted lead reaches the database and stops
there** — it never reaches Salesforce. Same for reminder tasks, the presence
sweep, and every dispatch timer.

Needs a host that runs a process continuously (Railway, Render, Fly, a small VM),
with `WORKER_DATABASE_URL` set to the session pooler.

---

## 2. Blocks launch — it would work, badly

### Rate limiting is per-process

`InMemoryRateLimiter`, applied to the public intake route among others. With N
serverless instances an attacker gets N× the limit, and every deploy resets the
counters. The public unauthenticated form is the most exposed thing on the site.

Needs Redis or Upstash behind the existing `RateLimiter` port. The call sites are
already in place; only the store is missing.

### Functions and database are on opposite sides of the world

Measured, not estimated:

|                                   |                          |
| --------------------------------- | ------------------------ |
| Vercel functions                  | `iad1` — Washington DC   |
| Supabase                          | `ap-northeast-2` — Seoul |
| Static CDN page                   | **0.12s**                |
| `/api/v1/health` — one `SELECT 1` | **1.2–3.6s**             |
| `/request-help`                   | **3.5s**                 |

A single trivial query costs over a second because every round trip crosses the
Pacific. Options: set the Vercel region to `icn1` (one line in `vercel.json`), or
move the Supabase project nearer the customers. The second is a data migration and
also rewrites the residency sentence in `/privacy`.

### Nothing enforces data retention

`/privacy` states two years for an enquiry and seven for completed work. Nothing
deletes anything today; the page says so explicitly. Either build the job or change
the page.

### Rotate the Supabase database password

It reached the conversation transcript through the IDE integration. The credential
works, so it is worth rotating and re-pasting into Vercel and `.env.supabase`.

### Backups

Confirm Supabase's backup/PITR settings are what you want. Not checked.

---

## 3. Should be done before you advertise it

- **Remove the runtime diagnostic** from `/api/v1/health` —
  `apps/web/lib/runtime-diagnostics.ts` plus three lines in the route and the
  optional contract field. It settled where Prisma's engine lands and has no
  further purpose; a filesystem-listing endpoint should not outlive its reason,
  even gated to previews.
- **Object storage** for expert photos. `LocalFileStorage` writes to the app
  server's disk, which does not survive a redeploy and does not exist on
  serverless.
- **EXIF stripping** on photo upload. Previously agreed as pre-launch: a phone
  photo can carry GPS coordinates.
- **Sentry**, or any error reporting. Currently nothing.
- **A Content-Security-Policy.** The other security headers are live; CSP was
  deferred until the provider origins were known.
- **Decide the Salesforce org.** The current one is a Developer Edition: 2 users
  and 5MB of data. The sales team cannot all sign in.
- **Sync approved experts into `Salesforce_Expert__c`.** The object exists and the
  upsert is proven; nothing calls it.
- **Production branch.** `main` auto-deploys to Production on Vercel, which is how
  several half-finished commits went live. Consider a separate production branch,
  or requiring CI green before promotion — CI does now actually run.
- **An FAQ**, once you know what people ask. The landing page's "How it works"
  covers part of it.
- **`robots.txt` and a sitemap**, once the domain exists.

---

## 4. Known, understood, and deliberately left

Not oversights. Each was a decision, and each is written down where it applies.

- **Payments are not built.** Paused on purpose after the corridor-pricing and
  FX work. `/about` and `/terms` both say no card details are taken.
- **`DISPATCH_MODE=exclusive`.** The interest-pool implementation is complete and
  tested but not the default, as agreed.
- **Instant matching is manual.** The team routes requests by hand.
  `/about` says the same rather than promising fifteen minutes.
- **The redaction scanner misses prose.** It catches `key=value` shaped secrets and
  known credential formats, not "my password is hunter2". The intake form warns
  about this, and `/privacy` calls it "a net with holes".
- **Photo review shares one `busyId`** between Approve and Reject, so clicking
  either spins both. Cosmetic; fix when the screen gets real use.
- **`RUNNING.md` is stale** relative to the Supabase and Vercel work.

---

## Shortest path to a launchable site

If the goal is a public site that works for both sides:

1. Buy the domain.
2. Mail provider on it, with SPF/DKIM/DMARC. _Unblocks expert signup and fixes the
   spam problem._
3. Deploy the worker somewhere always-on. _Leads start reaching Salesforce._
4. Redis rate limiter.
5. Fill in the legal entity; get privacy and terms reviewed; remove the banners.
6. Region decision, so pages load in hundreds of milliseconds rather than seconds.
7. Sentry and CSP.
8. Remove the diagnostic.

Steps 1–3 are the ones without which a real user hits a wall.
