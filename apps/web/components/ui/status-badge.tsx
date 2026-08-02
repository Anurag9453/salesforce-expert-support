import type { ExpertStatus } from "@sfx/contracts";
import { Badge } from "./badge.js";

/**
 * One rendering of expert status, used everywhere.
 *
 * Only APPROVED gets the "available" tone, so the colour never suggests
 * eligibility that the server would deny (requirement 2).
 */
const TONE: Record<ExpertStatus, "neutral" | "accent" | "available" | "warning" | "danger"> = {
  DRAFT: "neutral",
  SUBMITTED: "accent",
  UNDER_REVIEW: "accent",
  APPROVED: "available",
  REJECTED: "danger",
  SUSPENDED: "warning",
};

const LABEL: Record<ExpertStatus, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  UNDER_REVIEW: "Under review",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  SUSPENDED: "Suspended",
};

export function ExpertStatusBadge({ status }: { status: ExpertStatus }) {
  return <Badge tone={TONE[status]}>{LABEL[status]}</Badge>;
}
