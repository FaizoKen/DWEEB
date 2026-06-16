/**
 * "Look at Send" nudge.
 *
 * A one-shot signal that something wants to draw the user toward posting — most
 * notably the end of guided template setup, which closes its modal and points
 * the user back at the editor. Consumers watch `token` (a monotonic counter) as
 * an event: the editor's Send button pulses, and `App` raises the mobile
 * preview sheet so the message is visible before they tap Send.
 *
 * A tiny global store keeps this off prop chains, mirroring the other
 * cross-feature openers (`templateGalleryStore`, `managedMessagesStore`).
 */

import { create } from "zustand";

interface SendNudgeState {
  /** Bumped each time the user should be nudged toward the Send button. */
  token: number;
  nudge(): void;
}

export const useSendNudgeStore = create<SendNudgeState>((set) => ({
  token: 0,
  nudge: () => set((s) => ({ token: s.token + 1 })),
}));
