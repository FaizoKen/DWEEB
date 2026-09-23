/**
 * The toast queue: what is on screen, for how long, and when the clock stops.
 *
 * Kept apart from the view (`Toast.tsx`) so its timing rules are testable
 * without a DOM (toastQueue.test.ts). Callers keep importing `pushToast` from
 * `@/ui/Toast`, which re-exports it.
 */

import { startPausableTimer, type PausableTimer } from "./pausableTimer";

export type ToastTone = "info" | "success" | "error";

/** An optional one-tap follow-up shown inside the toast (Undo, Watch the intro…). */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  action?: ToastAction;
  /** Override the auto-dismiss delay (used as-is: no length scaling, no cap). */
  durationMs?: number;
}

export interface ToastEntry {
  id: number;
  message: string;
  tone: ToastTone;
  action?: ToastAction;
}

/** Why the countdowns are held: the pointer is on the stack, focus is in it, or the tab is hidden. */
export type ToastPauseReason = "hover" | "focus" | "hidden";

/** Plain feedback reads in a glance. */
const DEFAULT_MS = 3000;
/** Errors carry longer copy the user may need to act on. */
const ERROR_MS = 5000;
/**
 * A toast offering an action (typically Undo after a destructive edit) has to
 * outlast the moment of "wait, no" — but not so long it nags.
 */
const ACTION_MS = 7000;
/** Reading time: a beat to notice it, then ~60 ms a character (a relaxed ~170 words a minute). */
const READ_BASE_MS = 1000;
const READ_MS_PER_CHAR = 60;
/**
 * Longer copy earns more time, up to a point — a toast is no place to park a
 * paragraph, and hovering, focusing or the dismiss button cover anyone who
 * needs longer than this.
 */
export const MAX_TOAST_MS = 10_000;
/** A burst (a bulk action that toasts per item) must not wallpaper the screen: past this, the oldest leaves. */
export const MAX_VISIBLE_TOASTS = 3;
/** Once the pointer or focus moves off the stack, every toast gets at least this long before it goes. */
export const RESUME_FLOOR_MS = 1000;

/**
 * How long a toast stays up: the tone's minimum (3 s plain, 5 s error, 7 s with
 * an action), stretched for longer messages by reading time, capped at
 * {@link MAX_TOAST_MS}.
 */
export function toastDurationMs(message: string, tone: ToastTone, hasAction: boolean): number {
  const minimum = hasAction ? ACTION_MS : tone === "error" ? ERROR_MS : DEFAULT_MS;
  const reading = READ_BASE_MS + message.length * READ_MS_PER_CHAR;
  return Math.max(minimum, Math.min(reading, MAX_TOAST_MS));
}

let counter = 0;
let entries: readonly ToastEntry[] = [];
const timers = new Map<number, PausableTimer>();
const pauseReasons = new Set<ToastPauseReason>();
type Listener = (entries: readonly ToastEntry[]) => void;
const listeners = new Set<Listener>();

function publish(next: readonly ToastEntry[]): void {
  entries = next;
  for (const listener of listeners) listener(entries);
}

function stopTimer(id: number): void {
  timers.get(id)?.cancel();
  timers.delete(id);
}

export function dismissToast(id: number): void {
  stopTimer(id);
  if (entries.some((entry) => entry.id === id)) {
    publish(entries.filter((entry) => entry.id !== id));
  }
}

export function pushToast(
  message: string,
  tone: ToastTone = "info",
  options: ToastOptions = {},
): void {
  const { action, durationMs } = options;
  const id = ++counter;
  let next = [...entries, { id, message, tone, action }];
  // Oldest leaves first.
  while (next.length > MAX_VISIBLE_TOASTS) {
    stopTimer(next[0]!.id);
    next = next.slice(1);
  }
  timers.set(
    id,
    startPausableTimer(
      durationMs ?? toastDurationMs(message, tone, !!action),
      () => dismissToast(id),
      // Pushed while someone is reading the stack (or the tab is hidden): wait with the rest.
      pauseReasons.size > 0,
    ),
  );
  publish(next);
}

/** Hold every countdown while any reason applies; release them together once none does. */
export function setToastsPaused(reason: ToastPauseReason, paused: boolean): void {
  const wasPaused = pauseReasons.size > 0;
  if (paused) pauseReasons.add(reason);
  else pauseReasons.delete(reason);
  const isPaused = pauseReasons.size > 0;
  if (isPaused === wasPaused) return;
  for (const timer of timers.values()) {
    if (isPaused) timer.pause();
    else timer.resume(RESUME_FLOOR_MS);
  }
}

export function currentToasts(): readonly ToastEntry[] {
  return entries;
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: drop every toast, timer, pause and listener. */
export function __resetToasts(): void {
  for (const timer of timers.values()) timer.cancel();
  timers.clear();
  pauseReasons.clear();
  listeners.clear();
  entries = [];
}
