-- ─────────────────────────────────────────────────────────────────────────────
-- Rotate the candidate-pool cut so the tail of the bench cannot starve.
--
-- The candidate query returns a bounded pool. Its order is the fairness rule:
-- least-recently-assigned first. But `lastAssignedAt` is NULL for every expert
-- who has never been assigned anything, so on a growing bench they all tie, and
-- a stable tiebreak (previously `id`) admits the same prefix on every single
-- run. With 92 never-assigned experts and a pool of 50, the last 42 were never
-- looked at once — and left no exclusion row either, so the audit trail did not
-- show them being passed over.
--
-- `lastConsideredAt` breaks that tie by rotation: stamped for everyone the query
-- returns, and ordered NULLS FIRST, so never-considered experts lead and the
-- cut advances every run.
--
-- This changes *who is scored*, never *how*. Ranking, scores and the audited
-- `createRun` ordering all happen downstream and are unaware of this column.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "expert_profiles" ADD COLUMN "lastConsideredAt" TIMESTAMP(3);

CREATE INDEX "expert_profiles_lastAssignedAt_lastConsideredAt_idx"
  ON "expert_profiles" ("lastAssignedAt", "lastConsideredAt");
