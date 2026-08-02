-- Partial indexes. Prisma cannot express a WHERE clause on an index, so these
-- are hand-written and must be preserved across future schema changes.

-- ─────────────────────────────────────────────────────────────────────────────
-- THE load-bearing invariant (ARCHITECTURE.md §3.4).
--
-- "An expert can never hold two live offers at once."
--
-- Enforced here rather than in application code because application checks
-- race: two workers can both read "no open offer" before either writes one.
-- A partial unique index makes the second INSERT fail, and the losing worker
-- catches the violation and moves to the next-ranked candidate.
--
-- If this index is ever dropped, the dispatch loop becomes silently incorrect
-- under concurrency — the failure is a double-booked expert, not an error.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "one_open_offer_per_expert"
  ON "matching_attempts" ("expertProfileId")
  WHERE "status" = 'OFFERED';

-- Candidate query hot path: only APPROVED experts are ever eligible, so the
-- index carries only those rows (§3.8).
CREATE INDEX "expert_eligible_idx"
  ON "expert_profiles" ("availabilityStatus", "lastHeartbeatAt")
  WHERE "status" = 'APPROVED';

-- The dispatch worker scans only in-flight requests. Keeping COMPLETED and
-- terminal rows out of this index keeps it small as history accumulates.
CREATE INDEX "request_in_flight_idx"
  ON "support_requests" ("matchDeadlineAt")
  WHERE "state" IN ('CREATED', 'CLASSIFYING', 'SEARCHING', 'OFFERED');

-- Webhook replay check touches only unprocessed rows (§20).
CREATE INDEX "webhook_unprocessed_idx"
  ON "webhook_events" ("provider", "createdAt")
  WHERE "processedAt" IS NULL;

-- Exactly one active pricing tier per (duration, currency). Prevents two
-- overlapping prices being live at once, which would make quoting
-- non-deterministic.
CREATE UNIQUE INDEX "one_active_tier_per_duration_currency"
  ON "pricing_tiers" ("durationMinutes", "currency")
  WHERE "isActive" = true;
