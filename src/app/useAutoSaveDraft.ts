/**
 * Auto-saves the in-memory message to `localStorage` whenever it changes.
 *
 * Why a hook (and not a `subscribe` call inside the store): the store is the
 * single source of truth for *the message*. Persistence is a side effect that
 * belongs to the app shell — keeping it out of the store keeps the store
 * unit-testable without a `localStorage` polyfill.
 *
 * The save is debounced so a burst of keystrokes coalesces into one write.
 * On a slow disk this also keeps the input feeling instant.
 */

import { useEffect } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { saveDraft } from "@/core/state/draftStorage";

const DEBOUNCE_MS = 300;

export function useAutoSaveDraft(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = useMessageStore.subscribe((state, prev) => {
      if (state.message === prev.message) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => saveDraft(state.message), DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, []);
}
