/**
 * The notice for the people already in a collaboration room when someone else
 * is refused because the server's plan caps live co-editors.
 *
 * The person refused hears about it from their own `room_full` frame; the room
 * used to hear nothing, so the people who could raise the cap never learned a
 * teammate had been turned away. The server announces each refusal with a
 * `turned_away` frame (at most one a minute per room); this paces the toasts
 * further, so someone relaunching over and over can't bury the editor in them.
 */

/** How long after one notice the next is held back. */
export const TURNED_AWAY_NOTICE_GAP_MS = 10 * 60 * 1000;

let lastNoticeAt = -Infinity;

/** Whether a notice may be shown now — and, if so, records that it was. */
export function shouldNoteTurnedAway(now: number): boolean {
  if (now - lastNoticeAt < TURNED_AWAY_NOTICE_GAP_MS) return false;
  lastNoticeAt = now;
  return true;
}

/** Test seam: forget the last notice. */
export function resetTurnedAwayNotice(): void {
  lastNoticeAt = -Infinity;
}

/** "Sam couldn't join — this server's plan allows 2 live editors." */
export function turnedAwayNotice(name: string, cap: number): string {
  const who = name.trim() || "Someone";
  return cap > 0
    ? `${who} couldn't join — this server's plan allows ${cap} live editors.`
    : `${who} couldn't join — this room is full.`;
}
