-- ─────────────────────────────────────────────────────────────────────────────
-- An expert may be asked to confirm at most one request at a time.
--
-- The mirror of `one_confirming_per_request`, and just as load-bearing. Interest
-- is deliberately non-exclusive — an expert raises a hand on several requests at
-- once, and that is the point of the pool. But the moment a customer *picks*
-- them, exclusivity has to start, and nothing was enforcing it: two customers
-- could shortlist the same expert and both select, and both attempts went
-- CONFIRMING because each satisfied its own row's precondition and the
-- per-request index says nothing about the expert.
--
-- The visible symptom is worse than a double booking. `findPendingConfirmation
-- ForExpert` returns one row, so the expert is shown one of the two requests and
-- cannot even see the other — it just expires, while a customer watches a
-- two-minute countdown for an answer that was never going to arrive.
--
-- With this index the second selection loses at the database, `startConfirmation`
-- returns null, and the customer is told the expert is no longer available and
-- picks someone else from their shortlist. That path already exists.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "one_confirming_per_expert"
  ON "matching_attempts" ("expertProfileId")
  WHERE "status" = 'CONFIRMING';
