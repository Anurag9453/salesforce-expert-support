"use client";

import { useLinkStatus } from "next/link";
import { Spinner } from "./spinner.js";

/**
 * A spinner that appears while the `<Link>` it sits inside is navigating.
 *
 * `loading.tsx` covers the wait *after* a navigation commits, but there is a gap
 * before that: React has to fetch the next segment before it can render anything
 * at all, including the loading boundary. Against a database on another continent
 * that gap is long enough to click twice and conclude the button is broken —
 * which is exactly what it looks like, because nothing on screen changes.
 *
 * `useLinkStatus` closes it. The hook reports pending only for the link it is
 * rendered inside, so this is a component rather than a prop: it has to be a
 * descendant of the `<Link>` to know anything.
 *
 * A component rather than a wrapper around `Link`, deliberately. The entry cards
 * are a `<Link>` styled as a card, and a wrapper would have to fight their layout
 * to put the spinner where it belongs — inside the call to action, not appended
 * to the bottom of the card.
 *
 * Not for every link. One that resolves instantly does not need it, and a spinner
 * that flashes for 40ms is noise. Use it where the destination actually fetches.
 */
export function LinkPending({ className }: { className?: string }) {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return <Spinner size="sm" {...(className ? { className } : {})} />;
}
