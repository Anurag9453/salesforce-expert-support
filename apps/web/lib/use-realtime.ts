"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Subscribes to the realtime stream and calls `reconcile` whenever something
 * might have changed (requirements 3 and 14).
 *
 * The name is the design. This hook never hands the caller an event payload,
 * because the endpoint never sends one — it says "re-check now", and the caller's
 * `reconcile` fetches authoritative state. A component written against this hook
 * *cannot* trust a realtime message as state, because it is never given one.
 *
 * ## Reconciling, not resuming
 *
 * `reconcile` is called on three occasions, and the third is the one that
 * matters:
 *
 *   1. a signal arrives,
 *   2. the connection opens,
 *   3. **the connection re-opens after a drop.**
 *
 * Requirement 14: an expert who was disconnected while their offer expired must
 * come back to an accurate screen, not a resurrected card. Because reconnecting
 * triggers a fetch rather than a replay, they get whatever is true now — which is
 * "no offer" — and there is no code path that could do otherwise.
 *
 * ## The polling floor
 *
 * A slow interval runs underneath. Not redundancy for its own sake: if the
 * stream is silently dead — a proxy that swallowed it, a provider that failed —
 * the screen must still converge (requirement 10). It is deliberately slow enough
 * to be a safety net rather than a mechanism.
 */

export type RealtimeStatus = "connecting" | "live" | "offline";

const FALLBACK_POLL_MS = 15_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

export function useRealtime(
  reconcile: () => void | Promise<void>,
  options: { readonly enabled?: boolean } = {},
): RealtimeStatus {
  const enabled = options.enabled ?? true;
  const [status, setStatus] = useState<RealtimeStatus>("connecting");

  // Held in a ref so a caller passing an inline closure does not tear down and
  // rebuild the EventSource on every render.
  const reconcileRef = useRef(reconcile);
  reconcileRef.current = reconcile;

  useEffect(() => {
    if (!enabled) {
      setStatus("offline");
      return;
    }

    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectDelay = RECONNECT_BASE_MS;
    let disposed = false;

    const run = () => {
      void reconcileRef.current();
    };

    const connect = () => {
      if (disposed) return;
      source = new EventSource("/api/v1/realtime");

      source.addEventListener("ready", () => {
        reconnectDelay = RECONNECT_BASE_MS;
        setStatus("live");
        // Requirement 14. Every open — first or fiftieth — starts with a
        // reconciliation, so whatever happened while we were away is reflected.
        run();
      });

      source.addEventListener("signal", () => {
        // Requirement 2 and 3: the payload is ignored entirely. Two identical
        // signals cause two fetches and one outcome.
        run();
      });

      source.onerror = () => {
        setStatus("offline");
        source?.close();
        source = null;
        if (disposed) return;
        // EventSource reconnects on its own, but with no backoff and no way to
        // hook the re-open — so it is driven explicitly here instead.
        reconnectTimer = setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
      };
    };

    connect();

    // The safety net. Also covers a tab that was suspended, where neither the
    // stream nor its error handler necessarily fires.
    const poll = setInterval(run, FALLBACK_POLL_MS);

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      run();
      // A backgrounded tab's stream is often dead without an error event.
      if (!source) connect();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      disposed = true;
      clearInterval(poll);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      document.removeEventListener("visibilitychange", onVisible);
      source?.close();
    };
  }, [enabled]);

  return status;
}

/**
 * Reports a client-side timing point (requirement 16, points 6 and 8).
 *
 * Fire-and-forget: telemetry that can fail a user's action is worse than no
 * telemetry. Only the browser knows when a human could actually *see* something,
 * which is why these two points cannot be measured on the server.
 */
export function reportTiming(
  point: "expert_reconciled" | "customer_reconciled",
  fields: Record<string, unknown>,
): void {
  try {
    const body = JSON.stringify({ point, ...fields });
    // `sendBeacon` survives the page being closed, which matters when the thing
    // being measured is the last event before a navigation.
    if (typeof navigator !== "undefined" && "sendBeacon" in navigator) {
      navigator.sendBeacon(
        "/api/v1/telemetry/timing",
        new Blob([body], { type: "application/json" }),
      );
      return;
    }
    void fetch("/api/v1/telemetry/timing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Telemetry is never worth an error.
  }
}
