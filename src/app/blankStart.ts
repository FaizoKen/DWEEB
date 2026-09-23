/**
 * The error screen's "Start a blank message": start over on an empty message,
 * then open the editor without whatever the address was carrying (a share
 * link, a short link, a deep-link intent).
 *
 * The in-place reload is the escape for almost every crash; this is the one for
 * a crash the current draft itself keeps causing. It mirrors the editor's
 * "Clear all" — the message it replaces goes onto the undo history — and, since
 * the app (and with it the autosave) is unmounted, writes the draft and history
 * itself before leaving: `/` restores whatever draft is saved, so skipping the
 * write would reopen the very message that crashed.
 *
 * It lives in the App chunk and the error boundary reaches it through
 * `import("@/app/App")`, the chunk the boot already loads lazily. Importing the
 * store modules from the boundary directly (it sits in the entry chunk) made
 * the bundler split them into chunks of their own — four extra requests on
 * every visit, which the build's critical-request budget refused.
 */

import { useMessageStore } from "@/core/state/messageStore";
import { saveDraft } from "@/core/state/draftStorage";
import { saveHistory } from "@/core/state/historyStorage";

export function startBlankMessage(): void {
  try {
    useMessageStore.getState().clearAll();
    const { message, past, future } = useMessageStore.getState();
    saveDraft(message);
    saveHistory(past, future);
  } catch {
    // Opening the editor without the link can still be the fix on its own.
  }
  window.location.assign("/");
}
