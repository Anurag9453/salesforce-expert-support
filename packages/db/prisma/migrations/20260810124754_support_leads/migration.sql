-- CreateTable
CREATE TABLE "support_leads" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "contactedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_leads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "support_leads_contactedAt_createdAt_idx" ON "support_leads"("contactedAt", "createdAt");

-- AddForeignKey
ALTER TABLE "support_leads" ADD CONSTRAINT "support_leads_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
