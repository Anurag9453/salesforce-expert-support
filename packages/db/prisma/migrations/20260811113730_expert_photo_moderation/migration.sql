/*
  Warnings:

  - You are about to drop the column `photoUrl` on the `expert_profiles` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "PhotoModerationStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'REPLACED');

-- AlterTable
ALTER TABLE "expert_profiles" DROP COLUMN "photoUrl";

-- CreateTable
CREATE TABLE "expert_photos" (
    "id" TEXT NOT NULL,
    "expertProfileId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "status" "PhotoModerationStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "uploadedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expert_photos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "expert_photos_storageKey_key" ON "expert_photos"("storageKey");

-- CreateIndex
CREATE INDEX "expert_photos_expertProfileId_status_idx" ON "expert_photos"("expertProfileId", "status");

-- CreateIndex
CREATE INDEX "expert_photos_status_createdAt_idx" ON "expert_photos"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "expert_photos" ADD CONSTRAINT "expert_photos_expertProfileId_fkey" FOREIGN KEY ("expertProfileId") REFERENCES "expert_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expert_photos" ADD CONSTRAINT "expert_photos_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
