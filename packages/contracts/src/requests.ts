import { z } from "zod";
import {
  currencyCodeSchema,
  cuidSchema,
  difficultySchema,
  requestStateSchema,
  skillSourceSchema,
} from "./primitives.js";

/**
 * Support request contracts.
 *
 * The create schema is deliberately small (requirement 1): a description and a
 * tier. Everything else is optional, because the customer is describing a
 * symptom, not filling in a diagnostic form.
 */

export const MIN_DESCRIPTION_LENGTH = 20;
export const MAX_DESCRIPTION_LENGTH = 8000;

export const createRequestSchema = z.object({
  /**
   * Optional. Derived from the first sentence of the description when absent, so
   * the customer never has to compose a subject line before getting help.
   */
  title: z.string().trim().min(1).max(160).optional(),
  description: z
    .string()
    .trim()
    .min(MIN_DESCRIPTION_LENGTH, "Please describe the problem in at least a sentence or two.")
    .max(MAX_DESCRIPTION_LENGTH),
  /**
   * Assistive only (requirement 2). Wrong or empty selections cost the customer
   * nothing — the classifier and the description carry the real signal.
   */
  skillSlugs: z.array(z.string().min(1).max(80)).max(12).optional(),
  categorySlug: z.string().min(1).max(80).optional(),
  pricingTierId: cuidSchema,
  attachmentIds: z.array(cuidSchema).max(10).optional(),
});
export type CreateRequestInput = z.infer<typeof createRequestSchema>;

export const cancelRequestSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export const requestSkillViewSchema = z.object({
  slug: z.string(),
  name: z.string(),
  source: skillSourceSchema,
  isPrimary: z.boolean(),
  confidence: z.number().nullable(),
});

export const attachmentViewSchema = z.object({
  id: cuidSchema,
  filename: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  createdAt: z.string(),
});
export type AttachmentView = z.infer<typeof attachmentViewSchema>;

export const requestViewSchema = z.object({
  id: cuidSchema,
  title: z.string(),
  description: z.string(),
  state: requestStateSchema,
  stateEnteredAt: z.string(),
  createdAt: z.string(),
  matchDeadlineAt: z.string(),

  difficulty: difficultySchema.nullable(),
  /** Null while classifying, and permanently null if classification failed. */
  aiClassifiedAt: z.string().nullable(),
  aiConfidence: z.number().nullable(),
  aiModel: z.string().nullable(),

  price: z.object({
    amountMinor: z.number().int(),
    currency: currencyCodeSchema,
    durationMinutes: z.number().int(),
  }),

  skills: z.array(requestSkillViewSchema),
  attachments: z.array(attachmentViewSchema),

  /**
   * Who was matched, once someone has accepted.
   *
   * Deliberately thin. §39: the product sells fast access to the right
   * expertise, not a directory of freelancers — so this is enough for the
   * customer to feel they are in good hands and not enough to browse, compare,
   * or ask for someone else. There is no expert name, no photo, no profile link,
   * and no endpoint that would return one.
   */
  matchedExpert: z
    .object({
      yearsExperience: z.number().int().nullable(),
      /** How many of their relevant skills our team has independently checked. */
      verifiedSkillCount: z.number().int(),
      sessionsCompleted: z.number().int(),
    })
    .nullable(),

  /** Server-computed: whether the customer may still cancel. */
  cancellable: z.boolean(),
  /** Seconds until the matching deadline; negative once it has passed. */
  secondsUntilDeadline: z.number().int(),
});
export type RequestView = z.infer<typeof requestViewSchema>;

/** Returned on create so the UI can tell the customer what was redacted. */
export const secretFindingViewSchema = z.object({
  label: z.string(),
  severity: z.enum(["high", "medium", "low"]),
  occurrences: z.number().int(),
});

export const createRequestResponseSchema = z.object({
  request: requestViewSchema,
  secretFindings: z.array(secretFindingViewSchema),
  secretNotice: z.string().nullable(),
});

// ── Attachments ──────────────────────────────────────────────────────────────

/**
 * Upload allowlist (§30). Extension, MIME, and size are all checked server-side;
 * the client-side `accept` attribute is a convenience, not a control.
 *
 * No archives and no Office documents in V1 — a screenshot, a log, or a snippet
 * covers what an expert actually needs to see, and each additional type is
 * another parser to trust.
 */
export const ALLOWED_ATTACHMENT_TYPES = {
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/gif": [".gif"],
  "image/webp": [".webp"],
  "text/plain": [".txt", ".log"],
  "text/csv": [".csv"],
  "application/json": [".json"],
  "application/xml": [".xml"],
  "text/xml": [".xml"],
  "application/pdf": [".pdf"],
} as const satisfies Record<string, readonly string[]>;

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_REQUEST = 10;

export const presignUploadSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  contentType: z.enum(Object.keys(ALLOWED_ATTACHMENT_TYPES) as [string, ...string[]]),
  sizeBytes: z.coerce.number().int().positive().max(MAX_ATTACHMENT_BYTES),
});
export type PresignUploadInput = z.infer<typeof presignUploadSchema>;

export const presignUploadResponseSchema = z.object({
  attachmentId: cuidSchema,
  uploadUrl: z.string(),
  fields: z.record(z.string()),
  expiresAt: z.string(),
});

// ── Taxonomy (for the optional picker) ───────────────────────────────────────

export const taxonomyCategorySchema = z.object({
  slug: z.string(),
  name: z.string(),
  skills: z.array(z.object({ slug: z.string(), name: z.string() })),
});
export type TaxonomyCategory = z.infer<typeof taxonomyCategorySchema>;

export const pricingTierViewSchema = z.object({
  id: cuidSchema,
  name: z.string(),
  durationMinutes: z.number().int(),
  priceCents: z.number().int(),
  currency: currencyCodeSchema,
});
export type PricingTierView = z.infer<typeof pricingTierViewSchema>;

// ── Long-term support (lead capture only) ────────────────────────────────────

/**
 * The word ceiling the intake screen enforces.
 *
 * Words, not characters, because that is what the customer was asked for. The
 * schema still bounds characters — `MAX_DESCRIPTION_LENGTH` — since a word count
 * is not a safe limit on its own: one "word" can be arbitrarily long.
 */
export const MAX_DESCRIPTION_WORDS = 1000;

/** Whitespace-separated tokens. Deliberately simple, and identical on both sides. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

/**
 * Long-term support is not a product yet, so this captures a requirement and
 * promises nothing. No pricing, no matching, no state machine — see the
 * `SupportLead` comment in the schema.
 */
export const createSupportLeadSchema = z.object({
  summary: z
    .string()
    .trim()
    .min(MIN_DESCRIPTION_LENGTH, "Tell us a little about what you need.")
    .max(MAX_DESCRIPTION_LENGTH),
});
export type CreateSupportLeadInput = z.infer<typeof createSupportLeadSchema>;

export const supportLeadViewSchema = z.object({
  id: cuidSchema,
  summary: z.string(),
  createdAt: z.string(),
});
export type SupportLeadView = z.infer<typeof supportLeadViewSchema>;

/**
 * What we ask a customer for before they may submit a requirement.
 *
 * Two fields. No password — see the guest intake route for why the identity is
 * still real even though the signup form is not.
 */
export const guestIntakeSchema = z.object({
  name: z.string().trim().min(1, "Tell us what to call you.").max(120),
  email: z.string().trim().toLowerCase().email("That does not look like an email address."),
});
export type GuestIntakeInput = z.infer<typeof guestIntakeSchema>;
