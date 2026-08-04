"use client";

import { useEffect, useState } from "react";
import { Badge, Button } from "@/components/ui";
import {
  audioUnlocked,
  isMuted,
  notificationState,
  notificationsEnabled,
  requestNotificationPermission,
  setMuted,
  setNotificationsEnabled,
  unlockAudio,
  type NotificationState,
} from "@/lib/offer-alerts";

/**
 * Sound and notification controls (requirements 6 and 8).
 *
 * Both start **off** and both are turned on by a click that says what it does.
 * That is requirement 6 taken literally — no permission prompt on login, on
 * mount, or on any path the expert did not choose — and it is also the only
 * approach that works: a denied notification permission cannot be re-requested
 * in-app, so the single chance to ask is spent when the expert has just pressed
 * a button asking for it.
 *
 * The audio button exists for the same reason in reverse. Browsers refuse sound
 * until the page has been interacted with, so rather than trying silently and
 * failing silently, the expert presses "Enable sound", hears the tone, and knows
 * it works.
 */
export function AlertSettings() {
  const [muted, setMutedState] = useState(false);
  const [soundReady, setSoundReady] = useState(false);
  const [notify, setNotify] = useState<NotificationState>("default");
  const [notifyOptedIn, setNotifyOptedIn] = useState(false);
  const [busy, setBusy] = useState(false);

  // Read once on mount. Reading during render would differ between the server
  // and the client and produce a hydration mismatch.
  useEffect(() => {
    setMutedState(isMuted());
    setSoundReady(audioUnlocked());
    setNotify(notificationState());
    setNotifyOptedIn(notificationsEnabled());
  }, []);

  async function enableSound() {
    setBusy(true);
    const ok = await unlockAudio();
    setSoundReady(ok);
    if (ok) {
      setMuted(false);
      setMutedState(false);
    }
    setBusy(false);
  }

  async function enableNotifications() {
    setBusy(true);
    // The only place in the app that calls this, and only from this click.
    const result = await requestNotificationPermission();
    setNotify(result);
    setNotifyOptedIn(result === "granted");
    setBusy(false);
  }

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    setMutedState(next);
  }

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-border bg-surface-sunken px-4 py-3 text-sm">
      <span className="text-ink-muted">Alerts</span>

      {/* ── Sound ── */}
      {soundReady ? (
        <span className="flex items-center gap-2">
          <Badge tone={muted ? "neutral" : "available"}>{muted ? "Sound off" : "Sound on"}</Badge>
          <Button variant="ghost" size="sm" onClick={toggleMute}>
            {muted ? "Unmute" : "Mute"}
          </Button>
        </span>
      ) : (
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void enableSound()}>
          Enable sound
        </Button>
      )}

      {/* ── Notifications ── */}
      {notify === "unsupported" ? (
        <span className="text-xs text-ink-subtle">This browser has no notification support.</span>
      ) : notify === "denied" ? (
        // Honest about the dead end. Saying "enable notifications" to someone who
        // has already denied them would be a button that cannot work.
        <span className="text-xs text-ink-subtle">
          Notifications are blocked for this site — you would need to allow them in your browser
          settings.
        </span>
      ) : notifyOptedIn ? (
        <span className="flex items-center gap-2">
          <Badge tone="available">Notifications on</Badge>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              // Turning them off is ours to honour; the browser permission stays
              // granted, so turning them back on needs no second prompt.
              setNotificationsEnabled(false);
              setNotifyOptedIn(false);
            }}
          >
            Turn off
          </Button>
        </span>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => void enableNotifications()}
        >
          Enable notifications
        </Button>
      )}

      <span className="ml-auto text-xs text-ink-subtle">
        Offers always appear here, with or without alerts.
      </span>
    </div>
  );
}
