-- ─────────────────────────────────────────────────────────────────────────────
-- Vetting: reach them, and check what they claim.
--
-- Three additions, each closing a hole in "is this a genuine expert":
--
--   * `phone` — we asked customers for one and not the person we send to them.
--   * `trailheadUrl` — the single claim on the application a reviewer can
--     independently verify, and cheaply.
--   * `verifiedCertifications` — what the reviewer actually confirmed, kept
--     apart from the applicant's own `certifications` list. One is evidence and
--     the other is an assertion; a single column would silently promote every
--     unchecked claim into a verified one.
--
-- Nullable, because existing approved experts predate all three. Enforcement is
-- at the submission boundary, not in the column, so nobody already approved is
-- retroactively invalid.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "expert_profiles"
  ADD COLUMN "phone"                    TEXT,
  ADD COLUMN "trailheadUrl"             TEXT,
  ADD COLUMN "verifiedCertifications"   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "certificationsVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "certificationsVerifiedBy" TEXT;
