import type { AttachmentView, RequestView } from "@sfx/contracts";
import type { PrismaClient } from "@sfx/db";
import type { AttachmentRecord, SupportRequestRecord } from "@sfx/domain";
import { canTransition } from "@sfx/domain";

/**
 * Domain record → wire shape.
 *
 * `cancellable` is computed here from the state machine rather than hard-coded
 * as a list of states, so it can never drift from what the server would actually
 * allow. The UI hides the button; the service is what enforces it.
 */
export function toRequestView(
  record: SupportRequestRecord,
  attachments: readonly AttachmentRecord[],
  durationMinutes: number,
  now: Date = new Date(),
  matchedExpert: RequestView["matchedExpert"] = null,
): RequestView {
  return {
    id: record.id,
    title: record.title,
    description: record.description,
    state: record.state,
    stateEnteredAt: record.stateEnteredAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
    matchDeadlineAt: record.matchDeadlineAt.toISOString(),

    difficulty: record.difficulty,
    aiClassifiedAt: record.aiClassifiedAt?.toISOString() ?? null,
    aiConfidence: record.aiConfidence,
    aiModel: record.aiModel,

    price: {
      amountMinor: record.quotedPriceCents,
      currency: record.currency,
      durationMinutes,
    },

    skills: record.skills.map((skill) => ({
      slug: skill.slug,
      name: skill.name,
      source: skill.source,
      isPrimary: skill.isPrimary,
      confidence: skill.confidence,
    })),
    attachments: attachments.map(toAttachmentView),

    matchedExpert,
    cancellable: canTransition(record.state, "CANCELLED", "CUSTOMER"),
    secondsUntilDeadline: Math.round((record.matchDeadlineAt.getTime() - now.getTime()) / 1000),
  };
}

export function toAttachmentView(record: AttachmentRecord): AttachmentView {
  return {
    id: record.id,
    filename: record.filename,
    contentType: record.contentType,
    sizeBytes: record.sizeBytes,
    createdAt: record.createdAt.toISOString(),
  };
}

/**
 * The thin disclosure shown once an expert has accepted (§39, §Q11).
 *
 * Reads three numbers and nothing identifying. Returns null unless the request
 * actually has an assigned expert, so the shape cannot leak on an in-flight
 * request.
 */
export async function loadMatchedExpert(
  prisma: PrismaClient,
  record: SupportRequestRecord,
): Promise<RequestView["matchedExpert"]> {
  if (!record.assignedExpertId) return null;
  const requiredSkillIds = record.skills.map((skill) => skill.skillId);

  const expert = await prisma.expertProfile.findUnique({
    where: { id: record.assignedExpertId },
    select: {
      yearsExperience: true,
      sessionsCompleted: true,
      skills: {
        where: { verified: true, skillId: { in: requiredSkillIds } },
        select: { id: true },
      },
    },
  });
  if (!expert) return null;

  return {
    yearsExperience: expert.yearsExperience,
    verifiedSkillCount: expert.skills.length,
    sessionsCompleted: expert.sessionsCompleted,
  };
}
