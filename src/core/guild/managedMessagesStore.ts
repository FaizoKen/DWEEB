/**
 * Cross-feature opener for the per-server "Managed messages" dialog.
 *
 * The dialog itself is rendered by the account menu (mounted in the Builder's
 * action bar whenever the proxy is configured), but other surfaces need to
 * summon it — most notably the Send flow's pre-send confirm: when every
 * permanent slot is taken, its "Free a slot" action closes the whole send
 * stack and lands the user here. A tiny global store keeps that hand-off from
 * threading callbacks through the dialog stack (App → ShareDialog →
 * SendPanel → SendConfirm).
 */

import { create } from "zustand";

interface ManagedMessagesState {
  /** Guild the dialog is open for; null = closed. */
  guildId: string | null;
  /** Resolved server name, when the opener knew it. */
  guildName: string | undefined;
  open(guildId: string, guildName?: string): void;
  close(): void;
}

export const useManagedMessagesStore = create<ManagedMessagesState>((set) => ({
  guildId: null,
  guildName: undefined,
  open: (guildId, guildName) => set({ guildId, guildName }),
  close: () => set({ guildId: null, guildName: undefined }),
}));
