/**
 * Auto-saves the in-memory message + undo/redo history to `localStorage`
 * whenever they change.
 *
 * Why a hook (and not a `subscribe` call inside the store): the store is the
 * single source of truth for *the message*. Persistence is a side effect that
 * belongs to the app shell — keeping it out of the store keeps the store
 * unit-testable without a `localStorage` polyfill.
 *
 * The save is debounced so a burst of keystrokes coalesces into one write.
 * On a slow disk this also keeps the input feeling instant. A refresh or tab
 * close often lands inside the debounce window, so pagehide/visibility-hidden
 * flush any pending write — that's what makes the last edit (and its undo
 * step) survive an immediate refresh.
 */

import { useEffect } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { saveDraft } from "@/core/state/draftStorage";
import { saveHistory } from "@/core/state/historyStorage";

const DEBOUNCE_MS = 300;

export function useAutoSaveDraft(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      timer = null;
      const state = useMessageStore.getState();
      // Persist the update target as a non-credential pointer (message id + home
      // guild, no webhook token — that's recovered from the posted-messages store
      // on boot) so a reopened session re-links "Update existing" + the banner.
      const o = state.restoredFrom;
      saveDraft(
        state.message,
        o
          ? {
              messageId: o.messageId,
              threadId: o.threadId,
              guildId: o.guildId,
              guildName: o.guildName,
            }
          : undefined,
      );
      saveHistory(state.past, state.future);
    };

    const unsubscribe = useMessageStore.subscribe((state, prev) => {
      // Every edit pushes a history frame and undo/redo swaps the message, so
      // message and stacks change in lockstep — one flush writes both keys. The
      // restore origin can change on its own (a send re-targets the draft at the
      // now-live message without editing it), so it's watched too.
      if (
        state.message === prev.message &&
        state.past === prev.past &&
        state.future === prev.future &&
        state.restoredFrom === prev.restoredFrom
      ) {
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, DEBOUNCE_MS);
    });

    // Only flushes when a write is pending, so backgrounding an idle tab
    // costs nothing.
    const flushIfPending = () => {
      if (!timer) return;
      clearTimeout(timer);
      flush();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flushIfPending();
    };
    window.addEventListener("pagehide", flushIfPending);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      unsubscribe();
      window.removeEventListener("pagehide", flushIfPending);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (timer) clearTimeout(timer);
    };
  }, []);
}
