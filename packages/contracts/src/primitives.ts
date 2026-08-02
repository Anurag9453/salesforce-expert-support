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

export const expertStatusSchema = z.enum([
  "DRAFT",
  "SUBMITTED",
  "UNDER_REVIEW",
  "APPROVED",
  "REJECTED",
  "SUSPENDED",
]);
export type ExpertStatus = z.infer<typeof expertStatusSchema>;

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
