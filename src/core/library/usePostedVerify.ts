/**
 * Keeps a directory's Posted shelf in step with Discord.
 *
 * Posted history is the record of live Discord messages, but nothing tells
 * DWEEB when one is deleted in Discord. So while the Posted shelf is on
 * screen, the cards it shows are checked server-side (`library_verify.rs`) and
 * the ones whose message is gone are marked "Deleted on Discord". They stay on
 * the shelf for the server's retention period — a mistaken delete can't be
 * undone in Discord, so this copy is the way back — and load as a new post.
 * The proxy asks Discord about each entry at most once a minute and marks one
 * only on an answer that can't mean anything but "deleted"; this hook just
 * decides *which* entries are worth asking about — the ones a person can see.
 */

import { useEffect, useRef } from "react";
import type { LibraryEntryView } from "./api";
import { useLibraryStore } from "./libraryStore";

/** Toast copy for entries the check found deleted. `retentionSecs` is how
 * long the server keeps them (null = unknown, or a proxy that removes them). */
export function deletedPostsMessage(count: number, retentionSecs: number | null): string {
  const what = count === 1 ? "A post was" : `${count} posts were`;
  if (retentionSecs == null) return `${what} deleted on Discord.`;
  const days = Math.round(retentionSecs / 86_400);
  const kept = count === 1 ? "It stays" : "They stay";
  return `${what} deleted on Discord. ${kept} in Posted for ${days} days so you can post ${
    count === 1 ? "it" : "them"
  } again.`;
}

/**
 * Check the first `visibleCount` of `postedEntries` (the shelf as shown, newest
 * first) whenever the Posted shelf is active. `onDeleted` hears about every
 * entry newly found deleted — the caller reloads anything derived from them
 * (a deleted message's never-expire slot is released server-side).
 */
export function usePostedVerify(
  guildId: string | null | undefined,
  active: boolean,
  postedEntries: LibraryEntryView[],
  visibleCount: number,
  onDeleted: (entries: LibraryEntryView[]) => void,
): void {
  const onDeletedRef = useRef(onDeleted);
  onDeletedRef.current = onDeleted;
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
      .then((found) => {
        if (found.length > 0 && useLibraryStore.getState().guildId === guildId) {
          onDeletedRef.current(found);
        }
      });
  }, [guildId, visibleKey]);
}
