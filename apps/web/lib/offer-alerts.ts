"use client";

/**
 * The two ways an expert learns about an offer without looking at the screen:
 * a sound and a browser notification (requirements 6, 7, 8).
 *
 * Both are **strictly additive**. If either is blocked, denied, unsupported or
 * broken, the offer is still on the dashboard with a running countdown
 * (requirement 10). Nothing in this file can fail in a way that costs an expert
 * work.
 */

const MUTE_KEY = "sfx.offerSound.muted";
const NOTIFY_KEY = "sfx.offerNotifications.enabled";

// ── Sound ────────────────────────────────────────────────────────────────────

/**
 * The tone is synthesised, not a file.
 *
 * No asset to ship, nothing for the CSP to allow, nothing to 404, and it works
 * with no network. Two short notes a fifth apart — enough to be recognisable
 * across a room, short enough not to be irritating on the twentieth offer of a
 * day.
 */
const NOTES: ReadonlyArray<{ hz: number; at: number; for: number }> = [
  { hz: 880, at: 0, for: 0.13 },
  { hz: 1318.5, at: 0.15, for: 0.22 },
];

let audioContext: AudioContext | null = null;

/** Per device, deliberately. Sound on the desktop and silence on the laptop is a
 * coherent preference, and a server-side setting could not express it. */
export function isMuted(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(MUTE_KEY) === "1";
}

export function setMuted(muted: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
}

/**
 * Whether the browser will currently let us make a sound.
 *
 * Browsers refuse audio until the user has interacted with the page, and an
 * `AudioContext` created before that starts `suspended`. So the expert has to
 * press something once — which is why the UI has an explicit "Enable sound"
 * control rather than silently trying and silently failing.
 */
export function audioUnlocked(): boolean {
  return audioContext !== null && audioContext.state === "running";
}

/**
 * Called from a real click. Creates and resumes the context, then plays the tone
 * quietly so the expert can hear what they have signed up for.
 *
 * Returns whether it worked, so the UI can tell the truth rather than claim
 * success and be silent later.
 */
export async function unlockAudio(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  try {
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return false;

    audioContext ??= new Ctor();
    if (audioContext.state === "suspended") await audioContext.resume();
    if (audioContext.state !== "running") return false;

    playTone(0.25);
    return true;
  } catch {
    return false;
  }
}

/**
 * Plays the offer tone, if it can.
 *
 * Never throws and never awaits anything the caller depends on. A blocked or
 * broken audio stack is a silent offer, not a missing one.
 */
export function playOfferSound(): void {
  if (isMuted() || !audioUnlocked()) return;
  try {
    playTone(0.5);
  } catch {
    // Nothing to do and nothing worth telling the expert.
  }
}

function playTone(gainValue: number): void {
  const context = audioContext;
  if (!context) return;
  const now = context.currentTime;

  for (const note of NOTES) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = note.hz;
    // Ramped rather than switched: an instantaneous gain change is an audible
    // click on most hardware.
    gain.gain.setValueAtTime(0, now + note.at);
    gain.gain.linearRampToValueAtTime(gainValue, now + note.at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + note.at + note.for);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(now + note.at);
    oscillator.stop(now + note.at + note.for + 0.02);
  }
}

// ── Browser notifications ────────────────────────────────────────────────────

export type NotificationState = "unsupported" | "default" | "granted" | "denied";

export function notificationState(): NotificationState {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission as NotificationState;
}

/** Whether the expert has opted in *and* the browser agrees. */
export function notificationsEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(NOTIFY_KEY) === "1" && notificationState() === "granted";
}

export function setNotificationsEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(NOTIFY_KEY, enabled ? "1" : "0");
}

/**
 * Requests permission — **only ever from an explicit click** (requirement 6).
 *
 * Never called on mount, on login, or on any code path an expert did not choose.
 * A permission prompt nobody asked for is the fastest way to a permanent denial,
 * and a denial is not recoverable in-app: the expert has to go into browser
 * settings, which most never will. So the one chance to ask is spent when they
 * have just pressed a button that says what it is for.
 */
export async function requestNotificationPermission(): Promise<NotificationState> {
  const state = notificationState();
  if (state === "unsupported" || state === "denied") return state;
  if (state === "granted") {
    setNotificationsEnabled(true);
    return "granted";
  }
  try {
    const result = (await Notification.requestPermission()) as NotificationState;
    setNotificationsEnabled(result === "granted");
    return result;
  } catch {
    return notificationState();
  }
}

/**
 * Shows the offer notification (requirement 7).
 *
 * The content is deliberately thin: the skills and nothing else. **No customer
 * text, no title derived from their description, no request id.** A notification
 * is rendered by the operating system, may sit on a lock screen, may be read
 * aloud by an assistant, and may be seen by whoever is near the machine — so it
 * has to be safe in all of those places, and a customer's problem description
 * frequently is not. Everything specific lives behind the click.
 *
 * `tag` collapses successive notifications, so a stale one cannot linger next to
 * a current one.
 */
export function showOfferNotification(skills: readonly string[]): void {
  if (!notificationsEnabled()) return;
  try {
    const summary = skills.slice(0, 3).join(" · ");
    const notification = new Notification("New Salesforce support request", {
      body: summary ? `${summary} — open to review.` : "Open your dashboard to review it.",
      tag: "sfx-offer",
      // Not `requireInteraction`: an offer that expires in 60 seconds should not
      // leave a notification sitting on screen implying it is still actionable.
      silent: true,
    });
    notification.onclick = () => {
      try {
        window.focus();
        notification.close();
      } catch {
        // Nothing to recover.
      }
    };
  } catch {
    // Some browsers throw when constructing a Notification outside a service
    // worker. Not worth surfacing — the card is on screen either way.
  }
}
