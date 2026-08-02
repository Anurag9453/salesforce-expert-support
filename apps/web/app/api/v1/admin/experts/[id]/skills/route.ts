import { adminVerifySkillSchema } from "@sfx/contracts";
import { toExpertSkillView } from "@/lib/availability-view";
import { getContainer } from "@/lib/container";
import { apiOk, handleRoute, parseBody } from "@/lib/route-helpers";
import { requireActor } from "@/lib/session";

export const dynamic = "force-dynamic";

/** An expert's declared skills, as the reviewer sees them. */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { id } = await ctx.params;
    const skills = await getContainer().expertSkills.listForExpert(actor, id);
    return apiOk(skills.map(toExpertSkillView));
  });
}

/**
 * Verify or un-verify a skill (requirement 2).
 *
 * The single write path to `verified`, and it lives under `/admin` behind
 * `admin:verify_expert_skill`. Notes are mandatory: a verification is a claim
 * the platform is making on the expert's behalf to customers who cannot choose
 * their own expert, so there has to be a record of what it was based on.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { id } = await ctx.params;
    const body = await parseBody(request, adminVerifySkillSchema);
    if (!body.ok) return body.response;

    const record = await getContainer().expertSkills.setVerified(actor, {
      expertProfileId: id,
      skillSlug: body.data.skillSlug,
      verified: body.data.verified,
      notes: body.data.notes,
    });
    return apiOk(toExpertSkillView(record));
  });
}
