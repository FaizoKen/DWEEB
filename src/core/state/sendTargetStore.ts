/**
 * The web builder's destination-channel intent — which channel the next post
 * should land in, as picked in the action bar's channel picker (the web twin of
 * the Activity bar's destination, which lives in `activityStore` instead).
 *
 * This records *intent only*: no webhook is resolved or created here. The Send
 * dialog's channel-first picker reads it to auto-resolve a webhook for that
 * channel when it opens, and writes back whenever the user picks a different
 * channel there (or a send lands somewhere else), so the bar and the dialog
 * always agree on where the message is going.
 *
 * Scoped to a guild: the channel only means something in the server it belongs
 * to, so readers must ignore the value when `guildId` differs from the
 * connected guild (a server switch simply parks the old pick until the user
 * returns to that server).
 */

import { create } from "zustand";

interface SendTargetState {
  /** The server `channelId` belongs to, or null when nothing is picked. */
  guildId: string | null;
  /** The destination channel for the next new post, or null when unpicked. */
  channelId: string | null;
  setSendTarget(guildId: string, channelId: string | null): void;
}

export const useSendTargetStore = create<SendTargetState>((set, get) => ({
  guildId: null,
  channelId: null,
  setSendTarget(guildId, channelId) {
    const s = get();
    if (s.guildId === guildId && s.channelId === channelId) return;
    set({ guildId, channelId });
  },
}));
