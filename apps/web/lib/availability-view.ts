import type { AvailabilityLogEntryView, AvailabilityView, ExpertSkillView } from "@sfx/contracts";
import {
  REASON_COPY,
  type AvailabilityLogEntry,
  type AvailabilityView as DomainAvailabilityView,
  type ExpertSkillRecord,
} from "@sfx/domain";

/**
 * Domain records → wire shapes for the expert workspace.
 *
 * `messages` is resolved here from the domain's reason codes rather than in the
 * browser. Requirement 6 is that an expert can tell at a glance whether they are
 * eligible; that only holds if every client — web today, React Native later —
 * shows the same explanation, which means the server has to supply it
 * (requirement 9). The codes travel alongside so a client that wants its own
 * wording, or an analytics pipeline that wants to count reasons, still can.
 */
export function toAvailabilityView(view: DomainAvailabilityView): AvailabilityView {
  return {
    availabilityStatus: view.availabilityStatus,
    lastHeartbeatAt: view.lastHeartbeatAt?.toISOString() ?? null,
    secondsSinceHeartbeat: view.secondsSinceHeartbeat,
    heartbeatStaleAfterSeconds: view.heartbeatStaleAfterSeconds,
    heartbeatIntervalSeconds: view.heartbeatIntervalSeconds,
    eligibility: {
      eligible: view.eligibility.eligible,
      reasons: [...view.eligibility.reasons],
      messages: view.eligibility.reasons.map((reason) => REASON_COPY[reason]),
    },
  };
}

export function toAvailabilityLogView(entry: AvailabilityLogEntry): AvailabilityLogEntryView {
  return {
    id: entry.id,
    fromStatus: entry.fromStatus,
    toStatus: entry.toStatus,
    source: entry.source,
    changedByUserId: entry.changedByUserId,
    createdAt: entry.createdAt.toISOString(),
  };
}

/**
 * Note what is not here: `verifiedByUserId`.
 *
 * Which admin vouched for a skill is an internal detail; the expert needs to
 * know *that* it is verified, not who did it. It stays in the audit log.
 */
export function toExpertSkillView(record: ExpertSkillRecord): ExpertSkillView {
  return {
    skillSlug: record.slug,
    name: record.name,
    categorySlug: record.categorySlug,
    proficiencyLevel: record.proficiencyLevel,
    yearsExperience: record.yearsExperience,
    verified: record.verified,
    verifiedAt: record.verifiedAt?.toISOString() ?? null,
  };
}
