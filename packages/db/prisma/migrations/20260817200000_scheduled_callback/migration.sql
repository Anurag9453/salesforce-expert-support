-- ─────────────────────────────────────────────────────────────────────────────
-- Scheduled support: same problem, a time of their choosing.
--
-- Two columns rather than one. The instant is the truth — it survives daylight
-- saving, and it is what a reminder fires against. The IANA zone is what the
-- customer *meant*, and it is what has to be shown back to them: someone who
-- asked for 3pm expects to be told 3pm, not 09:30Z.
--
-- The zone is an id like `Asia/Kolkata`, never an offset like `+05:30`. An offset
-- has forgotten which country's rules produced it, so a callback booked in
-- October against a summer offset fires an hour late once the clocks go back.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TYPE "SupportType" ADD VALUE 'SCHEDULED' AFTER 'INSTANT';

ALTER TABLE "support_leads"
  ADD COLUMN "preferredCallAt"   TIMESTAMP(3),
  ADD COLUMN "preferredTimezone" TEXT;
