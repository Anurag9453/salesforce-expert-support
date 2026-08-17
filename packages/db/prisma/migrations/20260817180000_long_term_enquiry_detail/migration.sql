-- ─────────────────────────────────────────────────────────────────────────────
-- What a long-term enquiry actually needs to say.
--
-- A retainer is not a longer version of an instant request; it is a different
-- conversation, and the questions that open it are different. How long, at what
-- rate, on what basis, and is the number movable.
--
-- All nullable: an instant enquiry answers none of them, and forcing a default
-- would put a fictional budget on every one-off fix.
--
-- The amount is integer minor units, matching every other money column here. A
-- budget stored as a float is a budget that eventually disagrees with itself.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "EngagementUnit" AS ENUM ('WEEK', 'MONTH', 'YEAR');
CREATE TYPE "BudgetBasis" AS ENUM ('HOURLY', 'MONTHLY');

ALTER TABLE "support_leads"
  ADD COLUMN "title"             TEXT,
  ADD COLUMN "engagementCount"   INTEGER,
  ADD COLUMN "engagementUnit"    "EngagementUnit",
  ADD COLUMN "budgetBasis"       "BudgetBasis",
  ADD COLUMN "budgetAmountCents" INTEGER,
  ADD COLUMN "budgetCurrency"    TEXT,
  ADD COLUMN "budgetNegotiable"  BOOLEAN NOT NULL DEFAULT false;
