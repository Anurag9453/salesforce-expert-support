"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui";
import { useRealtime } from "@/lib/use-realtime";
import { cn } from "@/lib/utils";

/**
 * The notification bell.
 *
 * Realtime already tells a live page that something changed, but a doorbell has
 * no memory: an expert who closed their laptop for an hour has no way to learn
 * that three requests came and went. This is the durable record, and the realtime
 * signal is what makes the count update without a refresh.
 *
 * So the reconcile path is the same one every other live surface uses — a signal
 * causes a **re-fetch**, never an in-place edit from a payload. The list and the
 * badge therefore cannot drift from each other or from the server.
 *
 * Marking read happens when the panel is opened rather than per item. The bell's
 * job is to stop demanding attention once it has been looked at; per-item read
 * state invites a UI where the badge and the list disagree.
 */

interface NotificationItem {
  id: string;
  eventType: string;
  title: string;
  body: string | null;
  href: string | null;
  read: boolean;
  createdAt: string;
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const reconcile = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/notifications");
      const body = await response.json();
      if (!body.ok) return;
      setItems(body.data.items as NotificationItem[]);
      setUnread(body.data.unread as number);
      setLoaded(true);
    } catch {
      // A dropped fetch is not worth an error state in a header. The next signal
      // or the fallback poll will try again.
    }
  }, []);

  useRealtime(reconcile);

  // Close on outside click and on Escape — a dropdown that traps you is worse
  // than no dropdown.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next) return;

    if (!loaded) await reconcile();
    if (unread === 0) return;

    // Optimistic: the badge clears immediately, because waiting for a round-trip
    // to stop a red dot glowing feels broken. The POST is authoritative and a
    // failure is corrected by the next reconcile.
    setUnread(0);
    try {
      await fetch("/api/v1/notifications", { method: "POST" });
    } catch {
      void reconcile();
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => void toggle()}
        aria-expanded={open}
        aria-haspopup="true"
        // The count belongs in the label, not only in a coloured dot — a
        // screen-reader user needs the number, not the styling.
        aria-label={unread > 0 ? `Notifications, ${String(unread)} unread` : "Notifications"}
        className={cn(
          "interactive relative grid size-9 place-items-center rounded-md",
          open
            ? "bg-surface-sunken text-ink"
            : "text-ink-muted hover:bg-surface-sunken hover:text-ink",
        )}
      >
        <BellIcon ringing={unread > 0} />
        {unread > 0 && (
          <span
            aria-hidden="true"
            className="absolute -top-0.5 -right-0.5 grid min-w-4 place-items-center rounded-full bg-danger px-1 text-[0.625rem] leading-4 font-semibold text-ink-inverse"
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="region"
          aria-label="Notifications"
          className="animate-scale-in absolute right-0 z-50 mt-2 w-80 origin-top-right overflow-hidden rounded-xl border border-border bg-surface-raised shadow-lifted"
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <p className="text-sm font-semibold text-ink">Notifications</p>
            {items.length > 0 && <Badge>{items.length > 20 ? "20+" : items.length}</Badge>}
          </div>

          {items.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-ink-muted">
              {loaded ? "Nothing yet." : "Loading…"}
            </p>
          ) : (
            <ul className="max-h-96 divide-y divide-border overflow-y-auto">
              {items.map((item) => (
                <li key={item.id}>
                  <ItemBody item={item} onNavigate={() => setOpen(false)} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** A link when there is somewhere to go, plain text when there is not. */
function ItemBody({ item, onNavigate }: { item: NotificationItem; onNavigate: () => void }) {
  const inner = (
    <>
      <div className="flex items-start gap-2">
        {!item.read && (
          <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" />
        )}
        <p className={cn("text-sm", item.read ? "text-ink-muted" : "font-medium text-ink")}>
          {item.title}
        </p>
      </div>
      {item.body && (
        <p className="mt-1 pl-3.5 text-xs leading-relaxed text-ink-subtle">{item.body}</p>
      )}
      <p className="mt-1 pl-3.5 text-xs text-ink-subtle">
        <time dateTime={item.createdAt}>{relativeTime(item.createdAt)}</time>
      </p>
    </>
  );

  if (!item.href) return <div className="px-4 py-3">{inner}</div>;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className="interactive block px-4 py-3 hover:bg-surface-sunken"
    >
      {inner}
    </Link>
  );
}

/**
 * "4 min ago". Computed client-side only, so it never differs between the server
 * render and the browser — the classic source of a hydration mismatch on
 * anything time-relative.
 */
function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  return `${String(Math.round(hours / 24))}d ago`;
}

function BellIcon({ ringing }: { ringing: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("transition-transform", ringing && "origin-top -rotate-6")}
    >
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}
