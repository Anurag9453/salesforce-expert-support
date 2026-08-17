-- ─────────────────────────────────────────────────────────────────────────────
-- Leads become the product: anonymous, contact-bearing, CRM-bound.
--
-- Existing rows have a customer and no contact details, so the new columns are
-- backfilled from the account that raised them rather than defaulted to junk —
-- an enquiry whose email says 'unknown@example.com' is worse than no enquiry.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "support_leads"
  ADD COLUMN "name"             TEXT,
  ADD COLUMN "email"            TEXT,
  ADD COLUMN "phone"            TEXT,
  ADD COLUMN "durationMinutes"  INTEGER,
  ADD COLUMN "quotedPriceCents" INTEGER,
  ADD COLUMN "currency"         TEXT,
  ADD COLUMN "crmRef"           TEXT,
  ADD COLUMN "crmSyncedAt"      TIMESTAMP(3),
  ADD COLUMN "crmAttempts"      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "crmLastError"     TEXT;

UPDATE "support_leads" AS l
   SET "name"  = COALESCE(u."name", 'Unknown'),
       "email" = u."email",
       "phone" = ''
  FROM "customer_profiles" c
  JOIN "users" u ON u."id" = c."userId"
 WHERE l."customerId" = c."id";

-- Anything left has no account to backfill from; it predates contact capture.
UPDATE "support_leads"
   SET "name" = COALESCE("name", 'Unknown'),
       "email" = COALESCE("email", ''),
       "phone" = COALESCE("phone", '')
 WHERE "name" IS NULL OR "email" IS NULL OR "phone" IS NULL;

ALTER TABLE "support_leads"
  ALTER COLUMN "name"  SET NOT NULL,
  ALTER COLUMN "email" SET NOT NULL,
  ALTER COLUMN "phone" SET NOT NULL;

-- Anonymous enquiries are the normal case now, so the owner becomes optional.
ALTER TABLE "support_leads" ALTER COLUMN "customerId" DROP NOT NULL;
ALTER TABLE "support_leads" DROP CONSTRAINT IF EXISTS "support_leads_customerId_fkey";
ALTER TABLE "support_leads"
  ADD CONSTRAINT "support_leads_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "customer_profiles"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "support_leads_crmSyncedAt_createdAt_idx"
  ON "support_leads" ("crmSyncedAt", "createdAt");
