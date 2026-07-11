/**
 * Where the editor's next post is going — the little context the *shared*
 * builder needs to validate destination-dependent rules live (today: a
 * forum/media destination requires a post title, see `validateDestination`).
 *
 * The embedded Activity is the writer: its bar mirrors the picked channel's
 * kind/name here whenever the destination resolves or changes. The web app
 * never writes it (its Send panel resolves the destination at send time, long
 * after editing), so on the web this stays `null` and contributes nothing —
 * which is exactly why this lives in `core/state` rather than the Activity:
 * the shared validation layer can read it without dragging any Activity code
 * (SDK, collab, proxy fetch) into the web bundle.
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
