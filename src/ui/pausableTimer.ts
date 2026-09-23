/**
 * A one-shot countdown that can be paused and resumed without losing its place.
 *
 * Auto-dismissing surfaces (toasts, the rating card) must not expire while
 * someone is reading or reaching for them: the pointer resting on one, focus
 * inside it, or a hidden tab stops the clock, and resuming carries on with the
 * time that was left rather than starting over or firing at once.
 */

/** `setTimeout` treats a delay past 2^31-1 ms as 0, so cap it instead of firing at once. */
const MAX_DELAY_MS = 2_147_483_647;

export interface PausableTimer {
  /** Stop the countdown, keeping the time that is left. No-op when already paused or done. */
  pause(): void;
  /**
   * Continue the countdown. `floorMs` guarantees at least that much time is
   * left, so something that was just being read doesn't vanish the instant
   * attention moves off it. No-op while running or once done.
   */
  resume(floorMs?: number): void;
  /** Stop for good: `onExpire` will never run. */
  cancel(): void;
}

export function startPausableTimer(
  ms: number,
  onExpire: () => void,
  startPaused = false,
): PausableTimer {
  let remaining = Math.min(Math.max(0, ms), MAX_DELAY_MS);
  let startedAt = 0;
  let handle: ReturnType<typeof setTimeout> | null = null;
  let done = false;

  const run = () => {
    startedAt = Date.now();
    handle = setTimeout(() => {
      handle = null;
      done = true;
      onExpire();
    }, remaining);
  };

  if (!startPaused) run();

  return {
    pause() {
      if (handle === null) return;
      clearTimeout(handle);
      handle = null;
      remaining = Math.max(0, remaining - (Date.now() - startedAt));
    },
    resume(floorMs = 0) {
      if (done || handle !== null) return;
      remaining = Math.min(Math.max(remaining, floorMs), MAX_DELAY_MS);
      run();
    },
    cancel() {
      done = true;
      if (handle !== null) clearTimeout(handle);
      handle = null;
    },
  };
}
