-- ─────────────────────────────────────────────────────────────────────────────
-- One-off fix, or ongoing engagement?
--
-- Restores a question the intake used to ask and that the lead-capture rewrite
-- dropped. The reasoning for dropping it was that both answers end the same way
-- for us — a human follows up either way — but that is the platform's point of
-- view, not the customer's. A broken production job and a six-month retainer are
-- different conversations with different people, and the sales team should not
-- have to discover which one they are in halfway through a phone call.
--
-- Defaults to INSTANT so existing rows keep a truthful value: every enquiry
-- captured so far came through a form that only offered immediate help.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "SupportType" AS ENUM ('INSTANT', 'LONG_TERM');

ALTER TABLE "support_leads"
  ADD COLUMN "supportType" "SupportType" NOT NULL DEFAULT 'INSTANT';
