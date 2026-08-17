-- ─────────────────────────────────────────────────────────────────────────────
-- Two things a certification enquiry has to answer beyond which exam: when they
-- sit it, and what kind of help they actually want.
--
-- The date is a DATE, not a timestamp. An exam date is a calendar fact — the 12th
-- of September is the same day in Kolkata and California — and a timestamp would
-- invite a zone conversion that moves it either side of midnight.
--
-- The help is an array because these combine, and the combination is the signal:
-- somebody who wants a study plan *and* is retaking after a failure is a
-- different conversation from either on its own. Defaulted to empty so every lead
-- already captured stays valid.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "support_leads"
  ADD COLUMN "certificationExamOn" DATE,
  ADD COLUMN "certificationHelp"   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
