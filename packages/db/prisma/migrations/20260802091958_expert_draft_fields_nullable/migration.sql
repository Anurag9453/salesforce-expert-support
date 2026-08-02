-- AlterTable
ALTER TABLE "expert_profiles" ADD COLUMN     "submittedAt" TIMESTAMP(3),
ALTER COLUMN "country" DROP NOT NULL,
ALTER COLUMN "timezone" DROP NOT NULL,
ALTER COLUMN "yearsExperience" DROP NOT NULL,
ALTER COLUMN "professionalSummary" DROP NOT NULL;
