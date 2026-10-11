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
 * Optionally narrowed to a **thread** (or forum post) of that channel, picked
 * the same way — nested under its channel in the bar's picker, or in the Send
 * dialog's thread section. A thread only exists under its own channel (a
 * webhook can post into a thread of the channel it lives in, nowhere else), so
 * moving to another channel always drops it.
 *
 * Scoped to a guild: the channel only means something in the server it belongs
 * to, so readers must ignore the value when `guildId` differs from the
 * connected guild (a server switch simply parks the old pick until the user
 * returns to that server).
 */

import { create } from "zustand";

/** A thread (or forum post) under the picked channel. `name` is kept so the
 *  bar can label it before (or without) loading the channel's thread list. */
export interface SendThread {
  id: string;
  name: string | null;
}

interface SendTargetState {
  /** The server `channelId` belongs to, or null when nothing is picked. */
  guildId: string | null;
  /** The destination channel for the next new post, or null when unpicked. */
  channelId: string | null;
  /** The thread inside `channelId` the post goes into, or null for the channel
   *  itself (a forum: a new post). */
  thread: SendThread | null;
  /** Point at a channel. `thread` omitted keeps the current thread only while
   *  the channel is unchanged — another channel never inherits it. */
  setSendTarget(guildId: string, channelId: string | null, thread?: SendThread | null): void;
  /** Narrow the current channel to one of its threads, or back to the channel. */
  setSendThread(thread: SendThread | null): void;
}

function sameThread(a: SendThread | null, b: SendThread | null): boolean {
  return a === b || (a != null && b != null && a.id === b.id && a.name === b.name);
}

export const useSendTargetStore = create<SendTargetState>((set, get) => ({
  guildId: null,
  channelId: null,
  thread: null,
  setSendTarget(guildId, channelId, thread) {
    const s = get();
    const sameChannel = s.guildId === guildId && s.channelId === channelId;
    const nextThread =
      channelId == null ? null : thread !== undefined ? thread : sameChannel ? s.thread : null;
    if (sameChannel && sameThread(s.thread, nextThread)) return;
    set({ guildId, channelId, thread: nextThread });
  },
  setSendThread(thread) {
    const s = get();
    if (s.channelId == null || sameThread(s.thread, thread)) return;
    set({ thread });
  },
}));
