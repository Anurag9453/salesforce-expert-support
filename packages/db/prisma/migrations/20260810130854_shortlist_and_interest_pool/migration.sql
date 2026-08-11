-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AttemptStatus" ADD VALUE 'INTERESTED';
ALTER TYPE "AttemptStatus" ADD VALUE 'NOT_INTERESTED';
ALTER TYPE "AttemptStatus" ADD VALUE 'SHORTLISTED';
ALTER TYPE "AttemptStatus" ADD VALUE 'CONFIRMING';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RequestState" ADD VALUE 'SHORTLISTED';
ALTER TYPE "RequestState" ADD VALUE 'AWAITING_EXPERT_CONFIRMATION';

-- AlterTable
ALTER TABLE "expert_profiles" ADD COLUMN     "minutesDelivered" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "photoUrl" TEXT;
