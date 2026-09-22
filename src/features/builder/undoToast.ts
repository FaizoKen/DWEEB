/**
 * "Done — Undo" toast for destructive editor actions.
 *
 * Clearing the message or deleting a Container with children used to happen on
 * one click with no acknowledgement that anything recoverable had happened:
 * the bar's Undo icon is the only way back, and Ctrl+Z is deliberately inert
 * while focus sits in a text field (`useKeyboardShortcuts`). This pushes a
 * toast naming what was removed with an Undo action beside it.
 *
 * The action undoes only if the snapshot it would restore is still the top of
 * the history stack — i.e. the user hasn't edited since. Otherwise a stale
 * "Undo" would silently revert their newer work instead; it says so.
 */

import { useMessageStore } from "@/core/state/messageStore";
import type { WebhookMessage } from "@/core/schema";
import { pushToast } from "@/ui/Toast";

/**
 * Show `label` with an Undo that restores `before` — the message as it was
 * immediately before the destructive action. Capture it with
 * `useMessageStore.getState().message` *before* calling the store action.
 */
export function toastWithUndo(label: string, before: WebhookMessage): void {
  pushToast(label, "info", {
    action: {
      label: "Undo",
      onClick: () => {
        const store = useMessageStore.getState();
        const top = store.past[store.past.length - 1];
        if (top?.message === before) {
          store.undo();
          return;
        }
        pushToast("Can't undo that any more — the message has changed since.", "info");
      },
    },
  });
}
