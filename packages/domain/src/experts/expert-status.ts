import type { ExpertStatus } from "@sfx/contracts";
import { IllegalTransitionError } from "../shared/errors.js";
import type { TransitionActor } from "../support-requests/state-machine.js";

/**
 * Expert application lifecycle (§9).
 *
 *   DRAFT → SUBMITTED → UNDER_REVIEW → APPROVED ⇄ SUSPENDED
 *                    ↘             ↘ REJECTED → DRAFT
 *
 * Same shape as the support-request machine: a data table, validated
 * transitions, and no boolean flags. Pure, so the whole lifecycle is testable
 * without a database.
 */

export interface ExpertTransitionRule {
  readonly from: ExpertStatus;
  readonly to: ExpertStatus;
  readonly actors: readonly TransitionActor[];
  /** Required for every admin decision — requirement 3. */
  readonly requiresReason: boolean;
  readonly description: string;
}

export const EXPERT_TRANSITIONS: readonly ExpertTransitionRule[] = [
  {
    from: "DRAFT",
    to: "SUBMITTED",
    actors: ["EXPERT"],
    requiresReason: false,
    description: "Applicant submitted a complete application for review.",
  },
  {
    from: "SUBMITTED",
    to: "UNDER_REVIEW",
    actors: ["ADMIN"],
    requiresReason: false,
    description: "Admin picked the application up. Optional — an admin may decide directly.",
  },
  {
    from: "SUBMITTED",
    to: "APPROVED",
    actors: ["ADMIN"],
    requiresReason: true,
    description: "Approved straight from the queue.",
  },
  {
    from: "SUBMITTED",
    to: "REJECTED",
    actors: ["ADMIN"],
    requiresReason: true,
    description: "Rejected straight from the queue.",
  },
  {
    from: "UNDER_REVIEW",
    to: "APPROVED",
    actors: ["ADMIN"],
    requiresReason: true,
    description: "Approved after review.",
  },
  {
    from: "UNDER_REVIEW",
    to: "REJECTED",
    actors: ["ADMIN"],
    requiresReason: true,
    description: "Rejected after review.",
  },
  {
    from: "REJECTED",
    to: "DRAFT",
    actors: ["EXPERT", "ADMIN"],
    requiresReason: false,
    description: "Applicant reworked a rejected application. Rejection is recoverable.",
  },
  {
    from: "APPROVED",
    to: "SUSPENDED",
    actors: ["ADMIN"],
    requiresReason: true,
    description: "Admin suspended an approved expert. Removes eligibility immediately.",
  },
  {
    from: "SUSPENDED",
    to: "APPROVED",
    actors: ["ADMIN"],
    requiresReason: true,
    description: "Admin reinstated a suspended expert.",
  },
];

const INDEX: ReadonlyMap<string, ExpertTransitionRule> = new Map(
  EXPERT_TRANSITIONS.map((rule) => [`${rule.from}→${rule.to}`, rule]),
);

/**
 * Requirement 2 — the single authoritative answer to "may this expert be matched?"
 *
 * Deliberately takes a *status*, not an actor, so the question cannot be
 * answered by inspecting roles. Holding the EXPERT role is irrelevant here;
 * only an APPROVED application counts.
 *
 * Phases 4–5 add availability and heartbeat on top. This is the floor beneath
 * both: whatever else becomes true, a non-APPROVED expert is never a candidate.
 */
export function isEligibleForMatching(status: ExpertStatus | undefined | null): boolean {
  return status === "APPROVED";
}

/** Statuses an admin still needs to act on, in queue order. */
export const REVIEWABLE_STATUSES: readonly ExpertStatus[] = ["SUBMITTED", "UNDER_REVIEW"];

export function isPendingReview(status: ExpertStatus): boolean {
  return REVIEWABLE_STATUSES.includes(status);
}

export function findExpertTransition(
  from: ExpertStatus,
  to: ExpertStatus,
): ExpertTransitionRule | undefined {
  return INDEX.get(`${from}→${to}`);
}

export function canTransitionExpert(
  from: ExpertStatus,
  to: ExpertStatus,
  actor?: TransitionActor,
): boolean {
  const rule = findExpertTransition(from, to);
  if (!rule) return false;
  return actor === undefined || rule.actors.includes(actor);
}

export function nextExpertStatuses(from: ExpertStatus, actor?: TransitionActor): ExpertStatus[] {
  return EXPERT_TRANSITIONS.filter(
    (rule) => rule.from === from && (actor === undefined || rule.actors.includes(actor)),
  ).map((rule) => rule.to);
}

export function assertExpertTransition(
  from: ExpertStatus,
  to: ExpertStatus,
  actor: TransitionActor,
): ExpertTransitionRule {
  const rule = findExpertTransition(from, to);
  if (!rule) {
    const legal = nextExpertStatuses(from);
    throw new IllegalTransitionError<ExpertStatus>(
      from,
      to,
      legal.length > 0 ? `legal targets are ${legal.join(", ")}` : "status is terminal",
    );
  }
  if (!rule.actors.includes(actor)) {
    throw new IllegalTransitionError<ExpertStatus>(
      from,
      to,
      `actor ${actor} may not perform this transition (allowed: ${rule.actors.join(", ")})`,
    );
  }
  return rule;
}

/**
 * Fields an application must have before it may leave DRAFT.
 *
 * They are nullable in the database because a draft is genuinely incomplete;
 * completeness is enforced here, at the submit boundary.
 */
export const REQUIRED_FOR_SUBMISSION = [
  "country",
  "timezone",
  "yearsExperience",
  "professionalSummary",
  "termsAcceptedAt",
  "confidentialityAcceptedAt",
] as const;

export type SubmissionField = (typeof REQUIRED_FOR_SUBMISSION)[number];

export function missingForSubmission(
  application: Partial<Record<SubmissionField, unknown>>,
): SubmissionField[] {
  return REQUIRED_FOR_SUBMISSION.filter((field) => {
    const value = application[field];
    return value === null || value === undefined || value === "";
  });
}
