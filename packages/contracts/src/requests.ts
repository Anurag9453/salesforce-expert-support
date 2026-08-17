import { certificationHelpSchema, certificationSchema } from "./certifications.js";
import { z } from "zod";
import { timeZoneIdSchema } from "./geo.js";
import {
  budgetBasisSchema,
  cuidSchema,
  currencyCodeSchema,
  difficultySchema,
  engagementUnitSchema,
  requestStateSchema,
  skillSourceSchema,
  supportTypeSchema,
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
/**
 * A public enquiry. All three contact fields are mandatory, because the entire
 * point of the form is being able to reach the person afterwards.
 *
 * The messages are written to be read by a stranger who is already mildly
 * annoyed at filling in a form, so they say what to do rather than what is wrong.
 */
export const createSupportLeadSchema = z
  .object({
    name: z.string().trim().min(1, "Please tell us your name.").max(120),
    email: z.string().trim().toLowerCase().email("That email address does not look right."),
    /**
     * Loose on purpose. Phone numbers vary enormously by country and a strict
     * pattern rejects real people — this checks it is plausibly a number and
     * leaves the rest to the human who calls it.
     */
    phone: z
      .string()
      .trim()
      .min(6, "Please include a phone number we can reach you on.")
      .max(32)
      .regex(/^[+()\d][\d\s()+.-]*$/, "That phone number does not look right."),
    summary: z
      .string()
      .trim()
      .min(MIN_DESCRIPTION_LENGTH, "Tell us a little about what you need.")
      .max(MAX_DESCRIPTION_LENGTH),
    supportType: supportTypeSchema.default("INSTANT"),

    /* ── Long-term only. Optional here, required by the refinement below. ────── */

    title: z.string().trim().min(1, "Give this a short title.").max(160).optional(),
    /** 0-9. A dropdown, so the bound is the vocabulary rather than a validation. */
    engagementCount: z.coerce.number().int().min(0).max(9).optional(),
    engagementUnit: engagementUnitSchema.optional(),
    budgetBasis: budgetBasisSchema.optional(),
    /**
     * Entered in whole currency, stored in minor units by the route. Two decimal
     * places because an hourly rate of 62.50 is an ordinary thing to type.
     */
    budgetAmount: z.coerce
      .number()
      .nonnegative("A budget cannot be negative.")
      .max(10_000_000)
      .multipleOf(0.01, "Two decimal places at most.")
      .optional(),
    budgetNegotiable: z.boolean().default(false),

    /* ── Certification only ──────────────────────────────────────────────────── */

    /**
     * Which credential they are working towards, by display name.
     *
     * Validated against the catalogue rather than accepted as free text — see
     * `certificationSchema` for what that costs and why it is worth it.
     */
    certification: certificationSchema.optional(),
    /**
     * When they sit it, if it is booked. `YYYY-MM-DD`, no time and no zone.
     *
     * Date-only on purpose: an exam date is a calendar fact, not an instant, so
     * it needs none of the wall-clock-to-UTC machinery a callback time does — and
     * storing it as a timestamp would let a zone conversion move it a day.
     *
     * Optional even on this path. Plenty of people are studying before booking,
     * and a required date would turn "not yet" into a dead end.
     */
    examDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date picker.")
      .optional(),
    /** What kind of help, as distinct from which exam. At least one. */
    certificationHelp: certificationHelpSchema.optional(),

    /* ── Scheduled only ──────────────────────────────────────────────────────── */

    /** Wall clock as the customer typed it, `YYYY-MM-DDTHH:mm`. Converted server-side. */
    preferredCallAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Pick a date and a time.")
      .optional(),
    /** An IANA zone id. Never an offset — see `zonedWallClockToUtc`. */
    preferredTimezone: timeZoneIdSchema.optional(),
    /**
     * Optional, and genuinely so: a long-term enquiry has no duration to pick,
     * because nobody is buying an hour of anything.
     */
    pricingTierId: cuidSchema.optional(),
  })
  /*
    Conditional rather than blanket-required, because the two paths genuinely ask
    different questions. Marking these required outright would break the instant
    form; leaving them optional outright would let a retainer enquiry arrive with
    no idea of length or budget, which is the whole reason for asking.
  */
  .superRefine((value, ctx) => {
    if (value.supportType === "SCHEDULED") {
      for (const field of ["preferredCallAt", "preferredTimezone"] as const) {
        if (!value[field]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: "required for scheduled support",
          });
        }
      }
      return;
    }

    if (value.supportType === "CERTIFICATION") {
      if (!value.certification) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["certification"],
          message: "required for certification support",
        });
      }
      // The exam date stays optional — see the field. What they need help with
      // does not: it is the question that decides who picks the enquiry up.
      if (!value.certificationHelp || value.certificationHelp.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["certificationHelp"],
          message: "Tell us what you need help with.",
        });
      }
      return;
    }

    if (value.supportType !== "LONG_TERM") return;

    const required = [
      ["title", value.title],
      ["engagementCount", value.engagementCount],
      ["engagementUnit", value.engagementUnit],
      ["budgetBasis", value.budgetBasis],
      ["budgetAmount", value.budgetAmount],
    ] as const;

    for (const [field, provided] of required) {
      if (provided === undefined || provided === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: "required for long-term support",
        });
      }
    }
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
