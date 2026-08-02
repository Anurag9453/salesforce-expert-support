-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('CUSTOMER', 'EXPERT', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');

-- CreateEnum
CREATE TYPE "ExpertStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "AvailabilityStatus" AS ENUM ('OFFLINE', 'AVAILABLE', 'ON_OFFER', 'IN_SESSION');

-- CreateEnum
CREATE TYPE "AvailabilityChangeSource" AS ENUM ('MANUAL_TOGGLE', 'HEARTBEAT_TIMEOUT', 'OFFER_LOCK', 'OFFER_RELEASED', 'SESSION_START', 'SESSION_END', 'ADMIN');

-- CreateEnum
CREATE TYPE "ProficiencyLevel" AS ENUM ('BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'EXPERT');

-- CreateEnum
CREATE TYPE "Difficulty" AS ENUM ('BEGINNER', 'INTERMEDIATE', 'ADVANCED');

-- CreateEnum
CREATE TYPE "Urgency" AS ENUM ('INSTANT', 'SCHEDULED');

-- CreateEnum
CREATE TYPE "RequestState" AS ENUM ('CREATED', 'CLASSIFYING', 'SEARCHING', 'OFFERED', 'ACCEPTED', 'PAYMENT_PENDING', 'READY', 'IN_SESSION', 'COMPLETED', 'CANCELLED', 'NO_EXPERT_FOUND', 'DISPUTED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('SYSTEM', 'CUSTOMER', 'EXPERT', 'ADMIN');

-- CreateEnum
CREATE TYPE "SkillSource" AS ENUM ('CUSTOMER_SELECTED', 'AI_DETECTED');

-- CreateEnum
CREATE TYPE "AttemptOrigin" AS ENUM ('ALGORITHMIC', 'ADMIN_ASSIGN', 'ADMIN_FORCE_ASSIGN');

-- CreateEnum
CREATE TYPE "AttemptStatus" AS ENUM ('RANKED', 'OFFERED', 'ACCEPTED', 'DECLINED', 'TIMED_OUT', 'SUPERSEDED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "SessionState" AS ENUM ('SCHEDULED', 'READY', 'ACTIVE', 'COMPLETED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "ParticipantEventType" AS ENUM ('JOINED', 'LEFT', 'RECONNECTED');

-- CreateEnum
CREATE TYPE "ResolutionStatus" AS ENUM ('RESOLVED', 'PARTIALLY_RESOLVED', 'NOT_RESOLVED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('REQUIRES_METHOD', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('SESSION_EARNING', 'ADJUSTMENT', 'REFUND_CLAWBACK', 'PAYOUT');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL', 'PUSH', 'SMS');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'READ');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL,
    "image" TEXT,
    "roles" "UserRole"[] DEFAULT ARRAY['CUSTOMER']::"UserRole"[],
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "suspendedAt" TIMESTAMP(3),
    "suspendedReason" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verifications" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyName" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "preferredLanguages" TEXT[] DEFAULT ARRAY['en']::TEXT[],
    "paymentCustomerRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expert_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "ExpertStatus" NOT NULL DEFAULT 'DRAFT',
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedByUserId" TEXT,
    "reviewNotes" TEXT,
    "country" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "yearsExperience" INTEGER NOT NULL,
    "professionalSummary" TEXT NOT NULL,
    "languages" TEXT[] DEFAULT ARRAY['en']::TEXT[],
    "certifications" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "linkedinUrl" TEXT,
    "githubUrl" TEXT,
    "employmentStatus" TEXT,
    "termsAcceptedAt" TIMESTAMP(3),
    "confidentialityAcceptedAt" TIMESTAMP(3),
    "availabilityStatus" "AvailabilityStatus" NOT NULL DEFAULT 'OFFLINE',
    "lastHeartbeatAt" TIMESTAMP(3),
    "lastAvailableAt" TIMESTAMP(3),
    "lastAssignedAt" TIMESTAMP(3),
    "lastSessionCompletedAt" TIMESTAMP(3),
    "sessionsCompleted" INTEGER NOT NULL DEFAULT 0,
    "ratingSum" INTEGER NOT NULL DEFAULT 0,
    "ratingCount" INTEGER NOT NULL DEFAULT 0,
    "offersReceived" INTEGER NOT NULL DEFAULT 0,
    "offersAccepted" INTEGER NOT NULL DEFAULT 0,
    "avgResponseSeconds" INTEGER,
    "payoutRecipientRef" TEXT,
    "payoutsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expert_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "parentId" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skills" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expert_skills" (
    "id" TEXT NOT NULL,
    "expertProfileId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "proficiencyLevel" "ProficiencyLevel" NOT NULL,
    "yearsExperience" INTEGER NOT NULL DEFAULT 0,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedByUserId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expert_skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_requests" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "urgency" "Urgency" NOT NULL DEFAULT 'INSTANT',
    "state" "RequestState" NOT NULL DEFAULT 'CREATED',
    "stateEnteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "primaryCategoryId" TEXT,
    "difficulty" "Difficulty",
    "aiConfidence" DOUBLE PRECISION,
    "aiClassifiedAt" TIMESTAMP(3),
    "aiModel" TEXT,
    "aiFailureReason" TEXT,
    "matchDeadlineAt" TIMESTAMP(3) NOT NULL,
    "assignedExpertId" TEXT,
    "pricingTierId" TEXT NOT NULL,
    "quotedPriceCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "quotedPlatformFeeCents" INTEGER NOT NULL,
    "quotedExpertPayoutCents" INTEGER NOT NULL,
    "paymentAuthorizationRef" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledByUserId" TEXT,
    "cancellationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_request_skills" (
    "id" TEXT NOT NULL,
    "supportRequestId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "source" "SkillSource" NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_request_skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_request_state_history" (
    "id" TEXT NOT NULL,
    "supportRequestId" TEXT NOT NULL,
    "fromState" "RequestState",
    "toState" "RequestState" NOT NULL,
    "reason" TEXT,
    "actorType" "ActorType" NOT NULL,
    "actorUserId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_request_state_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" TEXT NOT NULL,
    "supportRequestId" TEXT,
    "uploadedByUserId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "redactionApplied" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matching_runs" (
    "id" TEXT NOT NULL,
    "supportRequestId" TEXT NOT NULL,
    "roundNumber" INTEGER NOT NULL,
    "relaxationLevel" INTEGER NOT NULL DEFAULT 0,
    "weightsSnapshot" JSONB NOT NULL,
    "thresholdsSnapshot" JSONB NOT NULL,
    "candidatePoolSize" INTEGER NOT NULL,
    "filtersApplied" JSONB NOT NULL DEFAULT '{}',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "matching_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matching_attempts" (
    "id" TEXT NOT NULL,
    "matchingRunId" TEXT NOT NULL,
    "supportRequestId" TEXT NOT NULL,
    "expertProfileId" TEXT NOT NULL,
    "origin" "AttemptOrigin" NOT NULL DEFAULT 'ALGORITHMIC',
    "rank" INTEGER,
    "skillScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "experienceScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ratingScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fairnessScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reliabilityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "finalScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "scoreBreakdown" JSONB NOT NULL DEFAULT '{}',
    "status" "AttemptStatus" NOT NULL DEFAULT 'RANKED',
    "offeredAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "responseSeconds" INTEGER,
    "declineReason" TEXT,
    "adminReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "matching_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expert_availability_log" (
    "id" TEXT NOT NULL,
    "expertProfileId" TEXT NOT NULL,
    "fromStatus" "AvailabilityStatus",
    "toStatus" "AvailabilityStatus" NOT NULL,
    "source" "AvailabilityChangeSource" NOT NULL,
    "changedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expert_availability_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_sessions" (
    "id" TEXT NOT NULL,
    "supportRequestId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "expertId" TEXT NOT NULL,
    "state" "SessionState" NOT NULL DEFAULT 'SCHEDULED',
    "videoProvider" TEXT,
    "videoRoomId" TEXT,
    "videoRoomExpiresAt" TIMESTAMP(3),
    "scheduledDurationMinutes" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "priceCents" INTEGER NOT NULL,
    "platformFeeCents" INTEGER NOT NULL,
    "expertPayoutCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "resolutionStatus" "ResolutionStatus",
    "expertNotes" TEXT,
    "expertNotesSharedWithCustomer" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_participant_events" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eventType" "ParticipantEventType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_participant_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ratings" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "raterUserId" TEXT NOT NULL,
    "ratedExpertId" TEXT NOT NULL,
    "stars" INTEGER NOT NULL,
    "review" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_tiers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "platformFeeBps" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pricing_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "supportRequestId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerRef" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "PaymentStatus" NOT NULL DEFAULT 'REQUIRES_METHOD',
    "authorizedAt" TIMESTAMP(3),
    "capturedAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "providerRef" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "initiatedByUserId" TEXT,
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "earnings_ledger_entries" (
    "id" TEXT NOT NULL,
    "expertProfileId" TEXT NOT NULL,
    "entryType" "LedgerEntryType" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "availableAt" TIMESTAMP(3) NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "earnings_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_configuration" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_configuration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "sentAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorType" "ActorType" NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "accounts_userId_idx" ON "accounts"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_providerId_accountId_key" ON "accounts"("providerId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_token_key" ON "auth_sessions"("token");

-- CreateIndex
CREATE INDEX "auth_sessions_userId_idx" ON "auth_sessions"("userId");

-- CreateIndex
CREATE INDEX "auth_sessions_expiresAt_idx" ON "auth_sessions"("expiresAt");

-- CreateIndex
CREATE INDEX "verifications_identifier_idx" ON "verifications"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "customer_profiles_userId_key" ON "customer_profiles"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "expert_profiles_userId_key" ON "expert_profiles"("userId");

-- CreateIndex
CREATE INDEX "expert_profiles_status_availabilityStatus_idx" ON "expert_profiles"("status", "availabilityStatus");

-- CreateIndex
CREATE INDEX "expert_profiles_availabilityStatus_lastHeartbeatAt_idx" ON "expert_profiles"("availabilityStatus", "lastHeartbeatAt");

-- CreateIndex
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");

-- CreateIndex
CREATE INDEX "categories_parentId_idx" ON "categories"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "skills_slug_key" ON "skills"("slug");

-- CreateIndex
CREATE INDEX "skills_categoryId_idx" ON "skills"("categoryId");

-- CreateIndex
CREATE INDEX "expert_skills_skillId_proficiencyLevel_idx" ON "expert_skills"("skillId", "proficiencyLevel");

-- CreateIndex
CREATE UNIQUE INDEX "expert_skills_expertProfileId_skillId_key" ON "expert_skills"("expertProfileId", "skillId");

-- CreateIndex
CREATE INDEX "support_requests_customerId_createdAt_idx" ON "support_requests"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "support_requests_state_matchDeadlineAt_idx" ON "support_requests"("state", "matchDeadlineAt");

-- CreateIndex
CREATE INDEX "support_requests_assignedExpertId_idx" ON "support_requests"("assignedExpertId");

-- CreateIndex
CREATE INDEX "support_request_skills_skillId_idx" ON "support_request_skills"("skillId");

-- CreateIndex
CREATE UNIQUE INDEX "support_request_skills_supportRequestId_skillId_source_key" ON "support_request_skills"("supportRequestId", "skillId", "source");

-- CreateIndex
CREATE INDEX "support_request_state_history_supportRequestId_createdAt_idx" ON "support_request_state_history"("supportRequestId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "attachments_storageKey_key" ON "attachments"("storageKey");

-- CreateIndex
CREATE INDEX "attachments_supportRequestId_idx" ON "attachments"("supportRequestId");

-- CreateIndex
CREATE INDEX "matching_runs_supportRequestId_idx" ON "matching_runs"("supportRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "matching_runs_supportRequestId_roundNumber_key" ON "matching_runs"("supportRequestId", "roundNumber");

-- CreateIndex
CREATE INDEX "matching_attempts_supportRequestId_rank_idx" ON "matching_attempts"("supportRequestId", "rank");

-- CreateIndex
CREATE INDEX "matching_attempts_expertProfileId_status_idx" ON "matching_attempts"("expertProfileId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "matching_attempts_matchingRunId_expertProfileId_key" ON "matching_attempts"("matchingRunId", "expertProfileId");

-- CreateIndex
CREATE INDEX "expert_availability_log_expertProfileId_createdAt_idx" ON "expert_availability_log"("expertProfileId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "support_sessions_supportRequestId_key" ON "support_sessions"("supportRequestId");

-- CreateIndex
CREATE INDEX "support_sessions_customerId_createdAt_idx" ON "support_sessions"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "support_sessions_expertId_createdAt_idx" ON "support_sessions"("expertId", "createdAt");

-- CreateIndex
CREATE INDEX "session_participant_events_sessionId_occurredAt_idx" ON "session_participant_events"("sessionId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "ratings_sessionId_key" ON "ratings"("sessionId");

-- CreateIndex
CREATE INDEX "ratings_ratedExpertId_createdAt_idx" ON "ratings"("ratedExpertId", "createdAt");

-- CreateIndex
CREATE INDEX "pricing_tiers_isActive_effectiveFrom_idx" ON "pricing_tiers"("isActive", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "payments_supportRequestId_key" ON "payments"("supportRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_providerRef_key" ON "payments"("providerRef");

-- CreateIndex
CREATE INDEX "payments_status_idx" ON "payments"("status");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_providerRef_key" ON "refunds"("providerRef");

-- CreateIndex
CREATE INDEX "refunds_paymentId_idx" ON "refunds"("paymentId");

-- CreateIndex
CREATE INDEX "earnings_ledger_entries_expertProfileId_createdAt_idx" ON "earnings_ledger_entries"("expertProfileId", "createdAt");

-- CreateIndex
CREATE INDEX "earnings_ledger_entries_expertProfileId_availableAt_idx" ON "earnings_ledger_entries"("expertProfileId", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "platform_configuration_key_key" ON "platform_configuration"("key");

-- CreateIndex
CREATE INDEX "notifications_userId_status_createdAt_idx" ON "notifications"("userId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "webhook_events_provider_processedAt_idx" ON "webhook_events"("provider", "processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_provider_externalEventId_key" ON "webhook_events"("provider", "externalEventId");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_createdAt_idx" ON "audit_logs"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_actorUserId_createdAt_idx" ON "audit_logs"("actorUserId", "createdAt");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_profiles" ADD CONSTRAINT "customer_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expert_profiles" ADD CONSTRAINT "expert_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expert_profiles" ADD CONSTRAINT "expert_profiles_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skills" ADD CONSTRAINT "skills_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expert_skills" ADD CONSTRAINT "expert_skills_expertProfileId_fkey" FOREIGN KEY ("expertProfileId") REFERENCES "expert_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expert_skills" ADD CONSTRAINT "expert_skills_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expert_skills" ADD CONSTRAINT "expert_skills_verifiedByUserId_fkey" FOREIGN KEY ("verifiedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_primaryCategoryId_fkey" FOREIGN KEY ("primaryCategoryId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_assignedExpertId_fkey" FOREIGN KEY ("assignedExpertId") REFERENCES "expert_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_pricingTierId_fkey" FOREIGN KEY ("pricingTierId") REFERENCES "pricing_tiers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_cancelledByUserId_fkey" FOREIGN KEY ("cancelledByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_request_skills" ADD CONSTRAINT "support_request_skills_supportRequestId_fkey" FOREIGN KEY ("supportRequestId") REFERENCES "support_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_request_skills" ADD CONSTRAINT "support_request_skills_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_request_state_history" ADD CONSTRAINT "support_request_state_history_supportRequestId_fkey" FOREIGN KEY ("supportRequestId") REFERENCES "support_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_request_state_history" ADD CONSTRAINT "support_request_state_history_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_supportRequestId_fkey" FOREIGN KEY ("supportRequestId") REFERENCES "support_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matching_runs" ADD CONSTRAINT "matching_runs_supportRequestId_fkey" FOREIGN KEY ("supportRequestId") REFERENCES "support_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matching_attempts" ADD CONSTRAINT "matching_attempts_matchingRunId_fkey" FOREIGN KEY ("matchingRunId") REFERENCES "matching_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matching_attempts" ADD CONSTRAINT "matching_attempts_supportRequestId_fkey" FOREIGN KEY ("supportRequestId") REFERENCES "support_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matching_attempts" ADD CONSTRAINT "matching_attempts_expertProfileId_fkey" FOREIGN KEY ("expertProfileId") REFERENCES "expert_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expert_availability_log" ADD CONSTRAINT "expert_availability_log_expertProfileId_fkey" FOREIGN KEY ("expertProfileId") REFERENCES "expert_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expert_availability_log" ADD CONSTRAINT "expert_availability_log_changedByUserId_fkey" FOREIGN KEY ("changedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_supportRequestId_fkey" FOREIGN KEY ("supportRequestId") REFERENCES "support_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_expertId_fkey" FOREIGN KEY ("expertId") REFERENCES "expert_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_participant_events" ADD CONSTRAINT "session_participant_events_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "support_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_participant_events" ADD CONSTRAINT "session_participant_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "support_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_raterUserId_fkey" FOREIGN KEY ("raterUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_ratedExpertId_fkey" FOREIGN KEY ("ratedExpertId") REFERENCES "expert_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_supportRequestId_fkey" FOREIGN KEY ("supportRequestId") REFERENCES "support_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_initiatedByUserId_fkey" FOREIGN KEY ("initiatedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "earnings_ledger_entries" ADD CONSTRAINT "earnings_ledger_entries_expertProfileId_fkey" FOREIGN KEY ("expertProfileId") REFERENCES "expert_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
