/**
 * Say so when the room connection drops — once — and once when it's back.
 *
 * Losing the collaboration socket used to show only as a colour change on a
 * 24px avatar ring, easy to miss while edits quietly stopped reaching everyone
 * else. This debounces the socket's raw up/down edges into at most one
 * "lost" and one "restored" notice per outage:
 *
 *  - a drop is announced only after it has lasted `lostAfterMs`, so the blips a
 *    reconnect heals at once never surface;
 *  - once announced, further flapping stays silent until the connection has
 *    held for `restoredAfterMs`, which is when "restored" is said — so a socket
 *    bouncing up and down can't turn into a stream of toasts;
 *  - nothing is said before the first successful connect (that's the launch,
 *    not a drop), or after `halt()` (collab stopped for good — room full or the
 *    session expired — where "reconnecting…" would be untrue).
 */

export interface ConnectionNoticeOptions {
  onLost: () => void;
  onRestored: () => void;
  /** How long a drop must last before it's announced. */
  lostAfterMs?: number;
  /** How long a recovered connection must hold before "restored" is said. */
  restoredAfterMs?: number;
}

export interface ConnectionNotifier {
  /** Feed every connected/disconnected edge from the socket. */
  update(connected: boolean): void;
  /** Collab stopped for good: cancel anything pending and stay silent. */
  halt(): void;
}

export const LOST_AFTER_MS = 4_000;
export const RESTORED_AFTER_MS = 2_000;

export function createConnectionNotifier({
  onLost,
  onRestored,
  lostAfterMs = LOST_AFTER_MS,
  restoredAfterMs = RESTORED_AFTER_MS,
}: ConnectionNoticeOptions): ConnectionNotifier {
  let everConnected = false;
  let connected = false;
  /** A "lost" notice is showing its outage — "restored" is owed. */
  let announced = false;
  let halted = false;
  let lostTimer: ReturnType<typeof setTimeout> | null = null;
  let restoredTimer: ReturnType<typeof setTimeout> | null = null;

  const clearLost = () => {
    if (lostTimer) clearTimeout(lostTimer);
    lostTimer = null;
  };
  const clearRestored = () => {
    if (restoredTimer) clearTimeout(restoredTimer);
    restoredTimer = null;
  };

  return {
    update(next) {
      if (halted) return;
      connected = next;
      if (next) {
        clearLost();
        if (!everConnected) {
          everConnected = true;
          return;
        }
        if (announced && !restoredTimer) {
          restoredTimer = setTimeout(() => {
            restoredTimer = null;
            announced = false;
            onRestored();
          }, restoredAfterMs);
        }
        return;
      }
      clearRestored();
      // Never live yet (still launching), already said, or already counting.
      if (!everConnected || announced || lostTimer) return;
      lostTimer = setTimeout(() => {
        lostTimer = null;
        if (connected) return;
        announced = true;
        onLost();
      }, lostAfterMs);
    },
    halt() {
      halted = true;
      clearLost();
      clearRestored();
    },
  };
}
