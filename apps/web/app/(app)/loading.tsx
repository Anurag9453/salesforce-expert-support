import { LoadingState } from "@/components/ui";

/**
 * Shown while any signed-in page fetches.
 *
 * One file at the group root rather than seventeen beside each `page.tsx`. The
 * App Router falls back to the nearest ancestor, so this covers the dashboard,
 * the expert workspace, every admin screen and both dynamic request routes —
 * and a route added tomorrow gets it without anyone remembering to.
 *
 * These pages query on the server, so before this existed a navigation left the
 * previous screen on display with nothing happening, which reads as a dead
 * click. Most of the wait is a database round trip to another continent.
 */
export default function Loading() {
  return <LoadingState label="Loading…" />;
}
