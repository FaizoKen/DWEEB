/**
 * Cross-feature opener for the per-server "Managed messages" dialog.
 *
 * The dialog itself is rendered by the account menu (mounted in the Builder's
 * action bar whenever the proxy is configured), but other surfaces summon it
 * too — e.g. the Send panel's "View & manage scheduled posts" link. A tiny
 * global store keeps those hand-offs from threading callbacks through the
 * dialog stack. (The pre-send confirm's slots-full "Free a slot" action used
 * to land here as well; never-expire management now lives in the gallery's
 * Posted tab, so that hand-off opens the gallery instead.)
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
