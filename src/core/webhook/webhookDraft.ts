/**
 * The webhook URL a user is entering **by hand**, held for the lifetime of one
 * Share-dialog open.
 *
 * The dialog mounts a separate panel per tab — `<SendPanel mode="new">`,
 * `<SendPanel mode="update">` and the Restore panel — and the Modal unmounts
 * whichever isn't shown, so every one of them lost its half-finished (or
 * just-committed) URL the moment the user looked at another tab: paste a
 * webhook on Send, hit "Done — use this webhook", glance at Update, come back,
 * and the field is empty again with "Paste it instead" offering to start over.
 * This store is the one piece of that state that outlives the panel: the raw
 * field text and whether the credential field is expanded (so a collapsed field
 * with a valid URL still reads as "committed" after a tab switch).
 *
 * Scope is deliberately narrow:
 *  - **Hand-entered URLs only.** A pick from the guild webhook picker or the
 *    recents list clears the draft instead of writing to it. Those paths
 *    re-resolve themselves on the next mount (the picker auto-resolves the
 *    action bar's channel; recents are rendered from storage), and a stale
 *    typed URL that outlived a later pick would quietly win on remount. It also
 *    keeps a Send-tab *destination* out of the Update tab's "which webhook
 *    posted this message" field, where it would only earn a 404.
 *  - **Memory only, one dialog open.** The URL is a credential, so it is never
 *    persisted (that is what the explicit "Save" / recents path is for) and
 *    `reset()` runs when the dialog closes, so nothing leaks into the next open.
 */

import { create } from "zustand";

export interface WebhookDraft {
  /** Raw field text, exactly as typed — never normalized, never persisted. */
  url: string;
  /** True while the credential field is expanded (i.e. not yet "Done"). */
  open: boolean;
}

interface WebhookDraftState extends WebhookDraft {
  setUrl: (url: string) => void;
  setOpen: (open: boolean) => void;
  reset: () => void;
}

const EMPTY: WebhookDraft = { url: "", open: false };

export const useWebhookDraftStore = create<WebhookDraftState>((set) => ({
  ...EMPTY,
  setUrl: (url) => set({ url }),
  setOpen: (open) => set({ open }),
  reset: () => set({ ...EMPTY }),
}));

/** Snapshot for a mount-time initializer (no subscription — panels re-mount). */
export function readWebhookDraft(): WebhookDraft {
  const { url, open } = useWebhookDraftStore.getState();
  return { url, open };
}

/** Record the credential field's contents. `""` drops the draft. */
export function setWebhookDraftUrl(url: string): void {
  useWebhookDraftStore.getState().setUrl(url);
}

/** Record whether the credential field is expanded. */
export function setWebhookDraftOpen(open: boolean): void {
  useWebhookDraftStore.getState().setOpen(open);
}

/** Drop the draft. Called when the Share dialog closes. */
export function resetWebhookDraft(): void {
  useWebhookDraftStore.getState().reset();
}
