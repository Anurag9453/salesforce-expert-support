-- ─────────────────────────────────────────────────────────────────────────────
-- At most one expert may be asked to confirm a request at a time.
--
-- The application already refuses to select a second candidate while one is
-- CONFIRMING, but that check reads the shortlist before it writes, so two
-- selections naming *different* attempts can both pass it: each one's own row
-- is still SHORTLISTED, so each UPDATE's own precondition holds. The result is
-- two experts asked to confirm the same request and a customer whose screen
-- shows one countdown for a race the other expert can still win.
--
-- Application logic cannot close that window; only the database can. Like
-- `one_open_offer_per_expert`, this is the invariant itself rather than a
-- performance hint — if it is ever dropped, the failure is a double-booked
-- request under concurrency, not an error anyone sees.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "one_confirming_per_request"
  ON "matching_attempts" ("supportRequestId")
  WHERE "status" = 'CONFIRMING';
