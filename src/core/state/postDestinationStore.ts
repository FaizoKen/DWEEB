/**
 * Where the editor's next post is going — the little context the *shared*
 * builder needs to validate destination-dependent rules live (today: a
 * forum/media destination requires a post title, see `validateDestination`).
 *
 * Both bars write it: the embedded Activity's mirrors the picked channel's
 * kind/name here whenever the destination resolves or changes, and the web
 * action bar does the same from its destination chip (for *new* posts only —
 * while its primary action is Update the next post PATCHes, where the
 * create-only rules don't apply, so it writes `null`). Without a known
 * destination (signed out, paste-a-URL) this stays `null` and contributes
 * nothing. It lives in `core/state` so the shared validation layer can read
 * it without dragging surface-specific code into either bundle.
 */

import { create } from "zustand";

interface PostDestinationState {
  /** The destination channel's Discord `type`, or null when no destination is
   *  known (web, or a DM launch before a channel is picked). */
  channelType: number | null;
  /** The destination channel's name (no leading `#`), for readable copy. */
  channelName: string | null;
  setPostDestination(channelType: number | null, channelName?: string | null): void;
}

export const usePostDestinationStore = create<PostDestinationState>((set, get) => ({
  channelType: null,
  channelName: null,
  setPostDestination(channelType, channelName = null) {
    const s = get();
    if (s.channelType === channelType && s.channelName === channelName) return;
    set({ channelType, channelName });
  },
}));
