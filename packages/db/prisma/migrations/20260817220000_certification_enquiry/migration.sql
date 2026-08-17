-- ─────────────────────────────────────────────────────────────────────────────
-- Certification support: help passing a specific Salesforce exam.
--
-- A fourth kind of enquiry, and the first one that is about a goal rather than a
-- problem. Nothing is broken — somebody is trying to pass something — which is
-- why it asks which credential instead of what went wrong.
--
-- The name is stored as text, not an enum. Salesforce owns this vocabulary and
-- edits it every year: credentials are retired, and the 2025 rebrand renamed most
-- of them at once. An enum, or a check constraint, would make each of those a
-- migration that rewrites what past customers actually asked for. The accepted
-- values are validated at the edge against the catalogue in `@sfx/contracts`,
-- where changing the list is an edit rather than a schema change.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TYPE "SupportType" ADD VALUE 'CERTIFICATION';

ALTER TABLE "support_leads"
  ADD COLUMN "certification" TEXT;
