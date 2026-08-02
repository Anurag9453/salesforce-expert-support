import type { ExpertApplication } from "@sfx/contracts";
import {
  isEligibleForMatching,
  missingForSubmission,
  type ExpertApplicationRecord,
} from "@sfx/domain";

/**
 * Domain record → wire shape.
 *
 * `eligibleForMatching` and `missingForSubmission` are computed here, on the
 * server, from the application's own status and fields. The client is shown the
 * answer and never the ingredients to derive its own (requirement 2).
 */
export function toExpertApplicationView(record: ExpertApplicationRecord): ExpertApplication {
  return {
    id: record.id,
    userId: record.userId,
    status: record.status,
    statusChangedAt: record.statusChangedAt.toISOString(),
    submittedAt: record.submittedAt?.toISOString() ?? null,
    reviewNotes: record.reviewNotes,
    country: record.country,
    timezone: record.timezone,
    yearsExperience: record.yearsExperience,
    professionalSummary: record.professionalSummary,
    languages: [...record.languages],
    certifications: [...record.certifications],
    linkedinUrl: record.linkedinUrl,
    githubUrl: record.githubUrl,
    employmentStatus: record.employmentStatus,
    termsAcceptedAt: record.termsAcceptedAt?.toISOString() ?? null,
    confidentialityAcceptedAt: record.confidentialityAcceptedAt?.toISOString() ?? null,
    eligibleForMatching: isEligibleForMatching(record.status),
    missingForSubmission: missingForSubmission(record),
  };
}
