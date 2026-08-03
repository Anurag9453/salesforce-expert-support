import { z } from "zod";

/** ISO-4217. Kept as a list so a typo can't create a phantom currency. */
export const currencyCodeSchema = z.enum(["INR", "USD", "GBP", "EUR", "AUD", "CAD", "SGD", "AED"]);
export type CurrencyCode = z.infer<typeof currencyCodeSchema>;

/**
 * Money on the wire, mirroring the database: integer minor units plus currency.
 * There is no decimal representation anywhere in the system by design.
 */
export const moneySchema = z.object({
  amountMinor: z.number().int(),
  currency: currencyCodeSchema,
});
export type Money = z.infer<typeof moneySchema>;

export const proficiencyLevelSchema = z.enum(["BEGINNER", "INTERMEDIATE", "ADVANCED", "EXPERT"]);
export type ProficiencyLevel = z.infer<typeof proficiencyLevelSchema>;

export const difficultySchema = z.enum(["BEGINNER", "INTERMEDIATE", "ADVANCED"]);
export type Difficulty = z.infer<typeof difficultySchema>;

export const requestStateSchema = z.enum([
  "CREATED",
  "CLASSIFYING",
  "SEARCHING",
  "OFFERED",
  "ACCEPTED",
  "PAYMENT_PENDING",
  "READY",
  "IN_SESSION",
  "COMPLETED",
  "CANCELLED",
  "NO_EXPERT_FOUND",
  "DISPUTED",
  "REFUNDED",
]);
export type RequestState = z.infer<typeof requestStateSchema>;

export const availabilityStatusSchema = z.enum(["OFFLINE", "AVAILABLE", "ON_OFFER", "IN_SESSION"]);
export type AvailabilityStatus = z.infer<typeof availabilityStatusSchema>;

/**
 * Why an availability change happened.
 *
 * Lives here rather than in the domain because the ports need it and a port may
 * not import a domain module — that would invert the dependency the whole
 * layering rests on. It is also on the wire, in the expert's own availability
 * history, so contracts is where it belongs regardless.
 */
export const availabilityChangeSourceSchema = z.enum([
  "MANUAL_TOGGLE",
  "HEARTBEAT_TIMEOUT",
  "OFFER_LOCK",
  "OFFER_RELEASED",
  "SESSION_START",
  "SESSION_END",
  "ADMIN",
]);
export type AvailabilityChangeSource = z.infer<typeof availabilityChangeSourceSchema>;

export const expertStatusSchema = z.enum([
  "DRAFT",
  "SUBMITTED",
  "UNDER_REVIEW",
  "APPROVED",
  "REJECTED",
  "SUSPENDED",
]);
export type ExpertStatus = z.infer<typeof expertStatusSchema>;

/**
 * Why a candidate was rejected by a matching filter (§C3).
 *
 * Here rather than in the domain for the same reason as
 * `availabilityChangeSourceSchema`: the ports need to name it, and a port may
 * not import a domain module. It is also persisted and rendered — an admin
 * reading "why B and not A" is reading these codes.
 */
export const exclusionReasonSchema = z.enum([
  "NOT_APPROVED",
  "ACCOUNT_NOT_ACTIVE",
  "NOT_AVAILABLE",
  "PRESENCE_STALE",
  "ALREADY_ON_OFFER",
  "IN_SESSION",
  "MISSING_PRIMARY_SKILL",
  "PRIMARY_BELOW_FLOOR",
  "INSUFFICIENT_SECONDARY_COVERAGE",
  "RATING_BELOW_FLOOR",
  "NO_LANGUAGE_OVERLAP",
  "ALREADY_RESPONDED",
  "IS_THE_CUSTOMER",
]);
export type ExclusionReason = z.infer<typeof exclusionReasonSchema>;

export const attemptStatusSchema = z.enum([
  "EXCLUDED",
  "RANKED",
  "OFFERED",
  "ACCEPTED",
  "DECLINED",
  "TIMED_OUT",
  "SUPERSEDED",
  "WITHDRAWN",
]);
export type AttemptStatus = z.infer<typeof attemptStatusSchema>;

export const attemptOriginSchema = z.enum(["ALGORITHMIC", "ADMIN_ASSIGN", "ADMIN_FORCE_ASSIGN"]);
export type AttemptOrigin = z.infer<typeof attemptOriginSchema>;

/** Requirement 9 — offered, never required. */
export const declineReasonSchema = z.enum([
  "NOT_MY_EXPERTISE",
  "NO_LONGER_AVAILABLE",
  "TOO_COMPLEX",
  "DURATION_NOT_SUITABLE",
  "OTHER",
]);
export type DeclineReasonCode = z.infer<typeof declineReasonSchema>;

export const userRoleSchema = z.enum(["CUSTOMER", "EXPERT", "ADMIN"]);
export type UserRole = z.infer<typeof userRoleSchema>;

export const skillSourceSchema = z.enum(["CUSTOMER_SELECTED", "AI_DETECTED"]);
export type SkillSource = z.infer<typeof skillSourceSchema>;

export const cuidSchema = z.string().min(1).max(64);

export const paginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type Pagination = z.infer<typeof paginationSchema>;
