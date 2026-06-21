/**
 * Quick-feedback dialog store.
 *
 * Owns just the open/close state of the feedback dialog. Mirrors the
 * lightweight pattern of `templateGalleryStore` / `aiStore` so any control —
 * the Builder action bar's "More" menu, the About panel, or anywhere else —
 * can summon the form without threading props through `App`.
 */

import { create } from "zustand";

interface FeedbackState {
  open: boolean;
  openFeedback(): void;
  closeFeedback(): void;
}

export const useFeedbackStore = create<FeedbackState>((set) => ({
  open: false,
  openFeedback() {
    set({ open: true });
  },
  closeFeedback() {
    set({ open: false });
  },
}));
