import { z } from "zod";
import { cuidSchema, expertStatusSchema } from "./primitives.js";
import { countryName, isCountryCode, isTimeZoneInCountry, TIME_ZONE_META } from "./geo.js";

/**
 * Expert application contracts.
 *
 * Two schemas on purpose: `draft` accepts partial input because a wizard saves
 * as you go, while `submission` demands a complete application. That split is
 * the contract-level mirror of nullable draft columns plus a submit-time check.
 */

const url = z.string().url().max(500);

/**
 * Country and time zone are picklist values, not free text.
 *
 * `country` is an ISO 3166-1 alpha-2 code and `timezone` is an IANA identifier
 * drawn from that country's list. Storing a code rather than a display name is
 * what makes the pair checkable at all — "India" and "Asia/Kolkata" cannot be
 * cross-referenced, "IN" and "Asia/Kolkata" can.
 *
 * The pair rule lives in `refineCountryTimeZone` below, applied at the object
 * level because neither field can validate the other on its own.
 */
const countryCode = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isCountryCode, "Choose a country from the list");

const timeZoneId = z
  .string()
  .trim()
  .refine((value) => value in TIME_ZONE_META, "Choose a time zone from the list");

/**
 * A zone must belong to the country chosen beside it, so "IN" +
 * "America/Los_Angeles" is rejected rather than silently stored. Reported
 * against `timezone`, because that is the field the applicant would change.
 */
export function refineCountryTimeZone(
  value: { country?: string | null; timezone?: string | null },
  ctx: z.RefinementCtx,
): void {
  const { country, timezone } = value;
  if (!country || !timezone) return;
  if (isTimeZoneInCountry(timezone, country)) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["timezone"],
    message: `That time zone is not one of ${countryName(country)}'s. Pick the country first, then its time zone.`,
  });
}
const ISO_LANGUAGE = /^[a-z]{2}(-[A-Z]{2})?$/;

/** Anything the applicant may set. Every field optional — this is a save, not a submit. */
export const expertApplicationDraftSchema = z
  .object({
    country: countryCode.optional(),
    timezone: timeZoneId.optional(),
    yearsExperience: z.coerce.number().int().min(0).max(60).optional(),
    professionalSummary: z.string().min(1).max(4000).optional(),
    languages: z
      .array(z.string().regex(ISO_LANGUAGE, "must be an ISO language code such as 'en' or 'en-IN'"))
      .max(20)
      .optional(),
    certifications: z.array(z.string().min(1).max(160)).max(40).optional(),
    linkedinUrl: url.or(z.literal("")).optional(),
    githubUrl: url.or(z.literal("")).optional(),
    employmentStatus: z.string().max(160).optional(),
    acceptTerms: z.boolean().optional(),
    acceptConfidentiality: z.boolean().optional(),
  })
  .superRefine(refineCountryTimeZone);
export type ExpertApplicationDraftInput = z.infer<typeof expertApplicationDraftSchema>;

/**
 * What a complete application looks like. Used to drive the UI's readiness
 * indicator; the authoritative check runs in the domain at submit time, because
 * a client-side check is a hint and never a gate.
 */
export const expertApplicationSubmissionSchema = z
  .object({
    country: countryCode,
    timezone: timeZoneId,
    yearsExperience: z.coerce.number().int().min(0).max(60),
    professionalSummary: z.string().min(80, "Tell us enough to review you fairly").max(4000),
    acceptTerms: z.literal(true),
    acceptConfidentiality: z.literal(true),
  })
  .superRefine(refineCountryTimeZone);

export const expertApplicationSchema = z.object({
  id: cuidSchema,
  userId: cuidSchema,
  status: expertStatusSchema,
  statusChangedAt: z.string(),
  submittedAt: z.string().nullable(),
  reviewNotes: z.string().nullable(),
  country: z.string().nullable(),
  timezone: z.string().nullable(),
  yearsExperience: z.number().nullable(),
  professionalSummary: z.string().nullable(),
  languages: z.array(z.string()),
  certifications: z.array(z.string()),
  linkedinUrl: z.string().nullable(),
  githubUrl: z.string().nullable(),
  employmentStatus: z.string().nullable(),
  termsAcceptedAt: z.string().nullable(),
  confidentialityAcceptedAt: z.string().nullable(),
  /** Server-computed. Never derived client-side (requirement 2). */
  eligibleForMatching: z.boolean(),
  missingForSubmission: z.array(z.string()),
});
export type ExpertApplication = z.infer<typeof expertApplicationSchema>;

// ── Admin ────────────────────────────────────────────────────────────────────

/**
 * A reason is mandatory on every consequential decision (requirement 3).
 * `claim` is the one action that changes nothing about the outcome, so it does
 * not demand one.
 */
export const adminExpertDecisionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("claim") }),
  z.object({
    decision: z.literal("approve"),
    notes: z.string().min(1, "Record why this expert was approved").max(2000),
  }),
  z.object({
    decision: z.literal("reject"),
    notes: z.string().min(1, "Record why this application was rejected").max(2000),
  }),
  z.object({
    decision: z.literal("suspend"),
    notes: z.string().min(1, "Record why this expert was suspended").max(2000),
  }),
  z.object({
    decision: z.literal("reinstate"),
    notes: z.string().min(1, "Record why this expert was reinstated").max(2000),
  }),
]);
export type AdminExpertDecision = z.infer<typeof adminExpertDecisionSchema>;

export const adminExpertListQuerySchema = z.object({
  status: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(",") : undefined))
    .pipe(z.array(expertStatusSchema).optional()),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

export const auditEntrySchema = z.object({
  id: cuidSchema,
  action: z.string(),
  actorUserId: z.string().nullable(),
  actorType: z.enum(["SYSTEM", "CUSTOMER", "EXPERT", "ADMIN"]),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  createdAt: z.string(),
});
export type AuditEntryView = z.infer<typeof auditEntrySchema>;

// ── Session ──────────────────────────────────────────────────────────────────

/** What the client is told about itself. Permissions are for rendering, not gating. */
export const sessionViewSchema = z.object({
  userId: cuidSchema,
  email: z.string().email(),
  name: z.string(),
  roles: z.array(z.enum(["CUSTOMER", "EXPERT", "ADMIN"])),
  status: z.enum(["ACTIVE", "SUSPENDED", "DELETED"]),
  expert: z
    .object({
      profileId: cuidSchema,
      status: expertStatusSchema,
      eligibleForMatching: z.boolean(),
    })
    .nullable(),
  permissions: z.array(z.string()),
});
export type SessionView = z.infer<typeof sessionViewSchema>;
