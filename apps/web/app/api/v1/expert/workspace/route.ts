import type { ExpertWorkspaceView } from "@sfx/contracts";
import { canGoAvailable } from "@sfx/domain";
import { toAvailabilityView, toExpertSkillView } from "@/lib/availability-view";
import { getContainer } from "@/lib/container";
import { apiOk, handleRoute } from "@/lib/route-helpers";
import { requireActor } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * The whole expert workspace in one call (requirement 9).
 *
 * A phone opening the app should be able to render the availability banner, the
 * skill list, and the toggle from a single round-trip. The web app composes the
 * same pieces server-side and so does not need this route — it exists for the
 * client that cannot.
 *
 * `canGoAvailable` is computed here rather than left to the client to infer from
 * `expertStatus`. Requirement 3's rule has exactly one definition, in the
 * domain, and every client is handed its answer.
 */
export async function GET() {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { expertAvailability, expertSkills } = getContainer();

    const [availability, skills] = await Promise.all([
      expertAvailability.getOwn(actor),
      expertSkills.listOwn(actor),
    ]);

    const view: ExpertWorkspaceView = {
      profileId: actor.expert?.profileId ?? "",
      expertStatus: actor.expert?.status ?? "DRAFT",
      canGoAvailable: canGoAvailable(actor.expert?.status ?? "DRAFT"),
      availability: toAvailabilityView(availability),
      skills: skills.map(toExpertSkillView),
    };
    return apiOk(view);
  });
}
