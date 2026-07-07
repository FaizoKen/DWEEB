/**
 * PWA install-prompt plumbing.
 *
 * The app has been installable ever since the manifest + precache service
 * worker shipped, but the only ways in were browser chrome (the address-bar
 * icon, Chrome's mini-infobar). This module gives the app its own entry point:
 *
 *  - `captureInstallPrompt()` — called once from `bootWeb`, before any lazy
 *    chunk loads — listens for Chromium's `beforeinstallprompt`, suppresses
 *    the browser's own promotion UI, and stashes the event.
 *  - The Builder's "Install app" menu item calls `promptInstall()`, which
 *    replays the stashed event: the real native install dialog, on our
 *    timing. Browsers that never fire the event (Safari, Firefox) resolve
 *    "unavailable" and the caller falls back to the per-platform instructions
 *    dialog (see `features/install`).
 *  - `subscribeInstall` / `getInstallSnapshot` feed `useSyncExternalStore`,
 *    so the menu item hides itself while running as the installed app
 *    (standalone display-mode) and the moment an install completes.
 *
 * Framework-free with every browser global guarded, so the module is safe to
 * import from the entry chunk and from Vitest's node environment alike.
 */

/** Chromium's install event — not in lib.dom, so declared here. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<unknown>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export interface InstallSnapshot {
  /** True when running as the installed app, or once `appinstalled` fires —
   *  either way the install entry point should disappear. */
  installed: boolean;
  /** True while a captured native prompt is waiting to be replayed. */
  canPrompt: boolean;
}

export type InstallPromptOutcome = "accepted" | "dismissed" | "unavailable";

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
let captured = false;

const listeners = new Set<() => void>();

/** Rebuilt on every change — `useSyncExternalStore` compares snapshots with
 *  `Object.is`, so the object must be stable between changes and fresh across
 *  them (see the same note in `attachmentStore`). */
let snapshot: InstallSnapshot = { installed: false, canPrompt: false };

function refresh(): void {
  snapshot = { installed, canPrompt: deferred != null };
  for (const fn of listeners) fn();
}

/** Already running as the installed app? Covers the standard display-mode
 *  media query plus iOS Safari's proprietary `navigator.standalone`. */
function runningStandalone(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
  return (navigator as { standalone?: boolean }).standalone === true;
}

/**
 * Start listening for the browser's install signals. Called synchronously from
 * `bootWeb` so the (Chromium-only) `beforeinstallprompt` — which can fire as
 * soon as the browser verifies the manifest — is never missed; a listener
 * added after the fact misses the event for good. Idempotent.
 */
export function captureInstallPrompt(): void {
  if (captured || typeof window === "undefined") return;
  captured = true;
  installed = runningStandalone();

  window.addEventListener("beforeinstallprompt", (e) => {
    // Without this, Chrome shows its own promotion (the mobile mini-infobar).
    // Suppressing it keeps install on the app's explicit menu entry.
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    refresh();
  });

  // Fired by Chromium when an install completes — whether it started from our
  // replayed prompt or from browser chrome. The stashed event is spent either way.
  window.addEventListener("appinstalled", () => {
    deferred = null;
    installed = true;
    refresh();
  });

  // Desktop Chrome moves the current tab into the new app window on install,
  // flipping display-mode to standalone without a reload.
  window.matchMedia?.("(display-mode: standalone)").addEventListener?.("change", (e) => {
    if (e.matches) {
      installed = true;
      refresh();
    }
  });

  refresh();
}

/** Subscribe to install-state changes (for `useSyncExternalStore`). */
export function subscribeInstall(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Current install state (for `useSyncExternalStore`). */
export function getInstallSnapshot(): InstallSnapshot {
  return snapshot;
}

/**
 * Replay the captured native install prompt. Resolves with the user's choice,
 * or "unavailable" when there is no prompt to show (non-Chromium browsers, a
 * spent prompt, or the app already installed) — the caller should fall back
 * to the manual-instructions dialog then.
 */
export async function promptInstall(): Promise<InstallPromptOutcome> {
  const evt = deferred;
  if (!evt) return "unavailable";
  // `prompt()` is single-use per event; drop it now so a second click can't
  // throw. Chromium re-fires `beforeinstallprompt` later if the user dismissed.
  deferred = null;
  refresh();
  try {
    await evt.prompt();
    return (await evt.userChoice).outcome;
  } catch {
    return "unavailable";
  }
}

export type InstallPlatform = "ios" | "android" | "safari-mac" | "firefox" | "chromium" | "unknown";

/**
 * Which manual-install instructions apply here. Parameterized on the UA string
 * and touch-point count so the decision table is unit-testable; callers use
 * the defaults.
 */
export function detectInstallPlatform(
  ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
  maxTouchPoints: number = typeof navigator === "undefined" ? 0 : (navigator.maxTouchPoints ?? 0),
): InstallPlatform {
  // iPadOS 13+ masquerades as macOS Safari; the touch-point count gives it away.
  const iPad = /Macintosh/.test(ua) && maxTouchPoints > 1;
  if (/iPhone|iPad|iPod/.test(ua) || iPad) return "ios";
  // Before Firefox: Android Firefox installs through the same browser-menu
  // route as Android Chrome, so the Android instructions cover both.
  if (/Android/.test(ua)) return "android";
  if (/Firefox\//.test(ua)) return "firefox";
  // Before Safari: every Chromium UA also claims "Safari", and Edge/Opera also
  // claim "Chrome".
  if (/Chrome\/|Chromium\/|Edg\//.test(ua)) return "chromium";
  if (/Safari\//.test(ua) && /Macintosh/.test(ua)) return "safari-mac";
  return "unknown";
}
