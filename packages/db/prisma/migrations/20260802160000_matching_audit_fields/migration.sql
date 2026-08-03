-- Phase 5 — what the matching engine has to be able to explain afterwards.
--
-- Three additions, each answering a question the audit trail could not answer
-- before:
--
--   1. EXCLUDED + exclusionReasons — "why was Expert A not even considered?"
--      Ranked-but-unoffered experts were already recorded; experts rejected by
--      a hard filter left no trace at all, which is exactly the case an
--      operator asks about.
--
--   2. offerExpiresAt — "is this 60-second window still the same one?"
--      Storing the deadline makes it a fact about the offer rather than a
--      property of a scheduled job, so a worker restart or a duplicate job
--      delivery cannot hand the expert a fresh window.
--
--   3. DeclineReason — "why do experts keep declining this kind of request?"
--      Structured, and deliberately optional.

-- ── 1. Excluded candidates are recorded, not discarded ──────────────────────
ALTER TYPE "AttemptStatus" ADD VALUE IF NOT EXISTS 'EXCLUDED' BEFORE 'RANKED';

ALTER TABLE "matching_attempts"
  ADD COLUMN "exclusionReasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- ── 2. The offer deadline is stored, not merely scheduled ───────────────────
ALTER TABLE "matching_attempts"
  ADD COLUMN "offerExpiresAt" TIMESTAMP(3);

-- ── 3. Structured decline reasons ───────────────────────────────────────────
CREATE TYPE "DeclineReason" AS ENUM (
  'NOT_MY_EXPERTISE',
  'NO_LONGER_AVAILABLE',
  'TOO_COMPLEX',
  'DURATION_NOT_SUITABLE',
  'OTHER'
);

-- Dropping and re-adding rather than casting in place.
--
-- `matching_attempts` has never held a row: Phase 5 is the first code that
-- writes to this table, so the drop is provably lossless rather than merely
-- convenient. A USING cast would be the right move on a table with history.
ALTER TABLE "matching_attempts" DROP COLUMN "declineReason";
ALTER TABLE "matching_attempts" ADD COLUMN "declineReason" "DeclineReason";
ALTER TABLE "matching_attempts" ADD COLUMN "declineNote" TEXT;

-- The dispatch loop's own hot path: "which attempt is currently open for this
-- request, and when does it expire?"
CREATE INDEX "attempt_open_offer_idx"
  ON "matching_attempts" ("supportRequestId", "offerExpiresAt")
  WHERE "status" = 'OFFERED';
