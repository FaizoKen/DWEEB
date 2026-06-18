/**
 * One-shot hand-off of a webhook into the Send panel.
 *
 * The Webhook Manager (rendered behind the account menu) can recover a webhook
 * URL and "use it in the builder" — but the Send panel lives under the App
 * shell's Share dialog, a separate subtree. This tiny store bridges them: the
 * Manager calls `send(webhook)`, the App shell observes the pending value, opens
 * the Share dialog on the Send tab prefilled with it, and clears the store. It
 * reuses the same `IncomingWebhook` shape the `webhook.incoming` redirect uses,
 * so the Send panel's existing prefill path handles both identically.
 */

import { create } from "zustand";
import type { IncomingWebhook } from "@/core/guild/config";

interface WebhookHandoffState {
  /** The webhook waiting to be dropped into Send, or null when none. */
  pending: IncomingWebhook | null;
  /** Hand a webhook to the Send panel. */
  send: (webhook: IncomingWebhook) => void;
  /** Clear the pending value once the App shell has consumed it. */
  clear: () => void;
}

export const useWebhookHandoff = create<WebhookHandoffState>((set) => ({
  pending: null,
  send: (webhook) => set({ pending: webhook }),
  clear: () => set({ pending: null }),
}));
