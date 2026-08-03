import { z } from "zod";
import {
  attemptOriginSchema,
  attemptStatusSchema,
  cuidSchema,
  declineReasonSchema,
  exclusionReasonSchema,
  proficiencyLevelSchema,
} from "./primitives.js";

/**
 * Matching contracts (§15, requirements 4, 9, 12, 13).
 *
 * Two audiences with deliberately different shapes:
 *
 *   - **The expert** sees an offer: what the problem is, how long they have, and
 *     two buttons. They do not see their score, their rank, or who else was
 *     considered. Showing an expert that they were third choice would poison the
 *     relationship for no benefit.
 *   - **The admin** sees the whole run: every candidate, every score component,
 *     every exclusion reason. That is what makes "why B and not A" answerable
 *     from the UI alone.
 */

// ── The expert's view of an offer ─────────────────────────────────────────────

export const offerViewSchema = z.object({
  attemptId: cuidSchema,
  supportRequestId: cuidSchema,
  title: z.string(),
  /** Already redacted at intake (§31). There is no unredacted copy anywhere. */
  description: z.string(),
  difficulty: z.enum(["BEGINNER", "INTERMEDIATE", "ADVANCED"]).nullable(),
  skills: z.array(z.object({ slug: z.string(), name: z.string(), isPrimary: z.boolean() })),
  durationMinutes: z.number().int(),
  payoutCents: z.number().int(),
  currency: z.string(),
  offeredAt: z.string(),
  /** The stored deadline. The client counts down to it rather than from a duration. */
  offerExpiresAt: z.string(),
  secondsRemaining: z.number().int(),
  /**
   * Requirement 13 — an expert can see that a human chose them.
   * Withholding it would make a manual assignment feel like an algorithmic one.
   */
  origin: attemptOriginSchema,
  adminNote: z.string().nullable(),
});
export type OfferView = z.infer<typeof offerViewSchema>;

export const respondToOfferSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("accept") }),
  z.object({
    decision: z.literal("decline"),
    /** Requirement 9 — offered, never required. */
    reason: declineReasonSchema.optional(),
    note: z.string().trim().max(500).optional(),
  }),
]);
export type RespondToOfferInput = z.infer<typeof respondToOfferSchema>;

/** Requirement 9's vocabulary, with the wording every client should use. */
export const DECLINE_REASON_LABELS: Record<z.infer<typeof declineReasonSchema>, string> = {
  NOT_MY_EXPERTISE: "Not my area",
  NO_LONGER_AVAILABLE: "No longer free right now",
  TOO_COMPLEX: "Needs more depth than I have here",
  DURATION_NOT_SUITABLE: "Won't fit the session length",
  OTHER: "Something else",
};

// ── The admin's view of a run ─────────────────────────────────────────────────

export const scoreBreakdownSchema = z.object({
  weightedAverage: z.number(),
  minPrimaryValue: z.number(),
  primaryBand: z.number(),
  perSkill: z.array(
    z.object({
      slug: z.string(),
      isPrimary: z.boolean(),
      proficiencyLevel: proficiencyLevelSchema.nullable(),
      verified: z.boolean(),
      value: z.number(),
      viaCategory: z.boolean(),
    }),
  ),
  shrunkRating: z.number(),
  acceptanceRate: z.number().nullable(),
  idleMinutes: z.number().nullable(),
  sessionsToday: z.number(),
});

export const matchingAttemptViewSchema = z.object({
  id: cuidSchema,
  expertProfileId: cuidSchema,
  expertEmail: z.string(),
  origin: attemptOriginSchema,
  rank: z.number().int().nullable(),
  status: attemptStatusSchema,
  scores: z.object({
    skill: z.number(),
    experience: z.number(),
    rating: z.number(),
    fairness: z.number(),
    reliability: z.number(),
    final: z.number(),
  }),
  breakdown: scoreBreakdownSchema.partial().nullable(),
  /** Requirement 4 — every reason, not the first one. */
  exclusionReasons: z.array(exclusionReasonSchema),
  offeredAt: z.string().nullable(),
  offerExpiresAt: z.string().nullable(),
  respondedAt: z.string().nullable(),
  responseSeconds: z.number().int().nullable(),
  declineReason: declineReasonSchema.nullable(),
  declineNote: z.string().nullable(),
  adminReason: z.string().nullable(),
});
export type MatchingAttemptView = z.infer<typeof matchingAttemptViewSchema>;

export const matchingRunViewSchema = z.object({
  id: cuidSchema,
  roundNumber: z.number().int(),
  relaxationLevel: z.number().int(),
  /** The floor and coverage that were in force. §C7: snapshotted, never re-derived. */
  filtersApplied: z.record(z.string(), z.unknown()),
  weightsSnapshot: z.record(z.string(), z.unknown()),
  candidatePoolSize: z.number().int(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  attempts: z.array(matchingAttemptViewSchema),
});
export type MatchingRunView = z.infer<typeof matchingRunViewSchema>;

/**
 * Everything needed to answer "why B and not A" for one request.
 *
 * Runs oldest first, so reading top to bottom is reading the search as it
 * happened: level 0 with its exclusions, then each relaxation step, then the
 * offer that landed.
 */
export const matchingAuditViewSchema = z.object({
  supportRequestId: cuidSchema,
  state: z.string(),
  createdAt: z.string(),
  matchDeadlineAt: z.string(),
  assignedExpertId: cuidSchema.nullable(),
  runs: z.array(matchingRunViewSchema),
});
export type MatchingAuditView = z.infer<typeof matchingAuditViewSchema>;

// ── Admin dispatch (requirement 12) ──────────────────────────────────────────

export const adminDispatchSchema = z.object({
  /**
   * `assign` picks a candidate; `force` overrides the competence rules too.
   * Neither bypasses the expert's acceptance — that is not the admin's to give.
   */
  mode: z.enum(["assign", "force"]),
  expertProfileId: cuidSchema,
  reason: z.string().trim().min(1, "Record why you are assigning this manually").max(2000),
});
export type AdminDispatchInput = z.infer<typeof adminDispatchSchema>;

/** A candidate as the admin dispatch picker shows them. */
export const dispatchCandidateSchema = z.object({
  expertProfileId: cuidSchema,
  email: z.string(),
  availabilityStatus: z.string(),
  expertStatus: z.string(),
  /** Null when they were excluded — there is no score for someone unranked. */
  finalScore: z.number().nullable(),
  rank: z.number().int().nullable(),
  exclusionReasons: z.array(exclusionReasonSchema),
  /** Whether `assign` would work, or whether only `force` can reach them. */
  assignable: z.boolean(),
});
export type DispatchCandidateView = z.infer<typeof dispatchCandidateSchema>;
