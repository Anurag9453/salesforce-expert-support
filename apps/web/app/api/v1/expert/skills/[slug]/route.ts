import { getContainer } from "@/lib/container";
import { apiOk, handleRoute } from "@/lib/route-helpers";
import { requireActor } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Remove one of the expert's own skills.
 *
 * Ownership is not taken from the URL — the slug names the skill, and the
 * expert is resolved from the session inside the service. There is no path here
 * to delete someone else's row.
 */
export async function DELETE(_request: Request, context: { params: Promise<{ slug: string }> }) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { slug } = await context.params;
    await getContainer().expertSkills.remove(actor, slug);
    return apiOk({ removed: slug });
  });
}
