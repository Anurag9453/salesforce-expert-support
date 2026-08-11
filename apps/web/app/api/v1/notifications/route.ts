import { apiOk, handleRoute } from "@/lib/route-helpers";
import { getContainer } from "@/lib/container";
import { requireActor } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * The bell's contents.
 *
 * Always the caller's own — there is no user id in the request to tamper with,
 * which is the same "remove the attack surface rather than guard it" approach the
 * realtime endpoint takes.
 */
export async function GET() {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { notifications } = getContainer();
    const result = await notifications.listMine(actor, { limit: 20 });

    return apiOk({
      unread: result.unread,
      items: result.items.map((item) => ({
        id: item.id,
        eventType: item.eventType,
        title: item.title,
        body: item.body,
        href: item.href,
        read: item.readAt !== null,
        createdAt: item.createdAt.toISOString(),
      })),
    });
  });
}

/** Marks everything read. See `NotificationService.markAllRead` for why it is not per-item. */
export async function POST() {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { notifications } = getContainer();
    const result = await notifications.markAllRead(actor);
    return apiOk(result);
  });
}
