import { z } from "zod";
import { refineCountryTimeZone } from "./experts.js";
import { isCountryCode, TIME_ZONE_META } from "./geo.js";
import {
  availabilityChangeSourceSchema,
  availabilityStatusSchema,
  cuidSchema,
  expertStatusSchema,
  proficiencyLevelSchema,
} from "./primitives.js";

/**
 * Expert workspace contracts (§11, §12).
 *
 * Shaped for a mobile client as much as the web one (requirement 9): every
 * operation is a plain JSON request, the eligibility answer arrives
 * pre-computed with reasons, and nothing requires a rendered page to interpret.
 */

// ── Availability & presence ──────────────────────────────────────────────────

export const ineligibilityReasonSchema = z.enum([
  "NOT_APPROVED",
  "ACCOUNT_NOT_ACTIVE",
  "NOT_AVAILABLE",
  "PRESENCE_STALE",
  "ALREADY_ON_OFFER",
  "IN_SESSION",
  "NO_MATCHING_SKILLS",
]);
export type IneligibilityReasonCode = z.infer<typeof ineligibilityReasonSchema>;

export const setAvailabilitySchema = z.object({
  available: z.boolean(),
});

export const availabilityViewSchema = z.object({
  availabilityStatus: availabilityStatusSchema,
  lastHeartbeatAt: z.string().nullable(),
  secondsSinceHeartbeat: z.number().int().nullable(),
  /** How long presence survives without a ping. Clients pace themselves off this. */
  heartbeatStaleAfterSeconds: z.number().int(),
  /** Suggested ping interval. Server-supplied so it can be tuned without a client release. */
  heartbeatIntervalSeconds: z.number().int(),
  /**
   * Requirement 4, answered by the server. The client never composes this from
   * status flags — it is told, and it is told why not.
   */
  eligibility: z.object({
    eligible: z.boolean(),
    reasons: z.array(ineligibilityReasonSchema),
    /** Human-readable, one per reason, in the same order. */
    messages: z.array(z.string()),
  }),
});
export type AvailabilityView = z.infer<typeof availabilityViewSchema>;

export const availabilityLogEntrySchema = z.object({
  id: cuidSchema,
  fromStatus: availabilityStatusSchema.nullable(),
  toStatus: availabilityStatusSchema,
  source: availabilityChangeSourceSchema,
  changedByUserId: z.string().nullable(),
  createdAt: z.string(),
});
export type AvailabilityLogEntryView = z.infer<typeof availabilityLogEntrySchema>;

// ── Skills ───────────────────────────────────────────────────────────────────

export const MAX_SKILL_YEARS = 40;

export const declareSkillSchema = z.object({
  skillSlug: z.string().min(1).max(80),
  proficiencyLevel: proficiencyLevelSchema,
  /** Years with *this skill*, not years in Salesforce. Zero is a real answer. */
  yearsExperience: z.coerce.number().int().min(0).max(MAX_SKILL_YEARS),
});
export type DeclareSkillInput = z.infer<typeof declareSkillSchema>;

export const expertSkillViewSchema = z.object({
  skillSlug: z.string(),
  name: z.string(),
  categorySlug: z.string(),
  proficiencyLevel: proficiencyLevelSchema,
  yearsExperience: z.number().int(),
  /**
   * Read-only to the expert (requirement 2). There is no request shape that
   * sets it — `declareSkillSchema` has no such field.
   */
  verified: z.boolean(),
  verifiedAt: z.string().nullable(),
});
export type ExpertSkillView = z.infer<typeof expertSkillViewSchema>;

/**
 * Requirement 7 — shipped to the client so the UI cannot invent softer wording.
 *
 * The definitions live in the domain (`PROFICIENCY_GUIDANCE`) and travel to
 * whichever client is rendering the picker. Anti-inflation copy that each client
 * writes for itself is anti-inflation copy that drifts.
 */
export interface ProficiencyGuidance {
  readonly label: string;
  readonly description: string;
}

export const adminVerifySkillSchema = z.object({
  skillSlug: z.string().min(1).max(80),
  verified: z.boolean(),
  notes: z.string().trim().min(1, "Record why this skill is being verified").max(2000),
});

// ── Profile ──────────────────────────────────────────────────────────────────

const optionalUrl = z.string().url().max(500).or(z.literal("")).optional();

/**
 * Exactly the self-editable fields, and no others (requirement 8).
 *
 * `.strict()` makes an unknown key a 400 rather than a silent drop, so a client
 * trying to set `status` gets told no instead of being quietly ignored — and
 * the domain filters again regardless.
 */
export const updateExpertProfileSchema = z
  .object({
    // Picklist values, same rule as the application (see experts.ts).
    country: z
      .string()
      .trim()
      .toUpperCase()
      .refine(isCountryCode, "Choose a country from the list")
      .optional(),
    timezone: z
      .string()
      .trim()
      .refine((value) => value in TIME_ZONE_META, "Choose a time zone from the list")
      .optional(),
    yearsExperience: z.coerce.number().int().min(0).max(60).optional(),
    professionalSummary: z.string().trim().min(80).max(4000).optional(),
    languages: z.array(z.string().min(2).max(10)).max(20).optional(),
    certifications: z.array(z.string().min(1).max(160)).max(40).optional(),
    linkedinUrl: optionalUrl,
    githubUrl: optionalUrl,
    employmentStatus: z.string().trim().max(160).optional(),
  })
  .strict()
  // A profile edit can change country and zone independently, so the pair check
  // has to run here too — otherwise someone moves country and keeps a zone that
  // no longer belongs to it.
  .superRefine(refineCountryTimeZone);
export type UpdateExpertProfileInput = z.infer<typeof updateExpertProfileSchema>;

/**
 * One call that answers "what is the state of my expert workspace?".
 *
 * Exists for the mobile client (requirement 9): a phone opening the workspace
 * should not need three round-trips before it can render anything. The web app
 * composes the same three pieces server-side.
 *
 * Session and earnings metrics are deliberately absent — Phase 9 owns them, and
 * a placeholder field now would be a promise the API cannot keep.
 */
export const expertWorkspaceViewSchema = z.object({
  profileId: cuidSchema,
  expertStatus: expertStatusSchema,
  /** Server-computed from the application status (requirement 3). */
  canGoAvailable: z.boolean(),
  availability: availabilityViewSchema,
  skills: z.array(expertSkillViewSchema),
});
export type ExpertWorkspaceView = z.infer<typeof expertWorkspaceViewSchema>;
