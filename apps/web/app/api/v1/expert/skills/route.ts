import { declareSkillSchema } from "@sfx/contracts";
import { toExpertSkillView } from "@/lib/availability-view";
import { getContainer } from "@/lib/container";
import { apiOk, handleRoute, parseBody } from "@/lib/route-helpers";
import { requireActor } from "@/lib/session";

export const dynamic = "force-dynamic";

/** The expert's own declared skills, each with its verification state. */
export async function GET() {
  return handleRoute(async () => {
    const actor = await requireActor();
    const skills = await getContainer().expertSkills.listOwn(actor);
    return apiOk(skills.map(toExpertSkillView));
  });
}

/**
 * Declare or update one skill (requirements 1 and 2).
 *
 * `declareSkillSchema` carries skill, proficiency, and years-with-this-skill —
 * and no `verified`. An expert cannot vouch for themselves because the request
 * shape gives them nothing to vouch with; the only write path to `verified` is
 * the admin route, which needs `admin:verify_expert_skill`.
 *
 * Re-declaring a verified skill clears the verification. That is deliberate: the
 * claim an admin checked has changed, so the old check no longer covers it.
 */
export async function PUT(request: Request) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const body = await parseBody(request, declareSkillSchema);
    if (!body.ok) return body.response;

    const record = await getContainer().expertSkills.declare(actor, body.data);
    return apiOk(toExpertSkillView(record));
  });
}
