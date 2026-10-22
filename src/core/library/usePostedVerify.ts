/**
 * Keeps a directory's Posted shelf in step with Discord.
 *
 * Posted history is the record of live Discord messages, but nothing tells
 * DWEEB when one is deleted in Discord. So while the Posted shelf is on
 * screen, the cards it shows are checked server-side (`library_verify.rs`) and
 * the ones whose message is gone drop out of the store. The proxy asks Discord
 * about each entry at most once a minute and removes an entry only on an
 * answer that can't mean anything but "deleted"; this hook just decides
 * *which* entries are worth asking about — the ones a person can see.
 */

import { useEffect, useRef } from "react";
import type { LibraryEntryView } from "./api";
import { useLibraryStore } from "./libraryStore";

/** Toast copy for entries the check removed. */
export function removedPostsMessage(count: number): string {
  return count === 1
    ? "Removed a post that was deleted on Discord."
    : `Removed ${count} posts that were deleted on Discord.`;
}

/**
 * Check the first `visibleCount` of `postedEntries` (the shelf as shown, newest
 * first) whenever the Posted shelf is active. `onRemoved` hears about every
 * entry that was dropped — the caller reloads anything derived from them
 * (a deleted message's never-expire slot is released server-side with it).
 */
export function usePostedVerify(
  guildId: string | null | undefined,
  active: boolean,
  postedEntries: LibraryEntryView[],
  visibleCount: number,
  onRemoved: (removed: LibraryEntryView[]) => void,
): void {
  const onRemovedRef = useRef(onRemoved);
  onRemovedRef.current = onRemoved;
  // A key of the visible ids, so hydrating a card (a new entry object with the
  // same id) doesn't re-run the check; the store's per-entry interval would
  // skip it anyway, this just avoids the work.
  const visibleKey = active
    ? postedEntries
        .slice(0, Math.max(0, visibleCount))
        .map((entry) => entry.id)
        .join(",")
    : "";
  useEffect(() => {
    if (!guildId || !visibleKey) return;
    void useLibraryStore
      .getState()
      .verifyPosted(guildId, visibleKey.split(","))
      .then((removed) => {
        if (removed.length > 0 && useLibraryStore.getState().guildId === guildId) {
          onRemovedRef.current(removed);
        }
      });
  }, [guildId, visibleKey]);
}
