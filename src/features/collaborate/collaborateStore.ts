/**
 * "Collaborate in Discord" dialog store.
 *
 * Owns just the open/close state of the collaboration-link dialog. Mirrors the
 * lightweight pattern of `feedbackStore` / `templateGalleryStore` so any control —
 * the Builder action bar's "More" menu, and anywhere else — can summon it without
 * threading props through `App`.
 */

import { create } from "zustand";

interface CollaborateState {
  open: boolean;
  openCollaborate(): void;
  closeCollaborate(): void;
}

export const useCollaborateStore = create<CollaborateState>((set) => ({
  open: false,
  openCollaborate() {
    set({ open: true });
  },
  closeCollaborate() {
    set({ open: false });
  },
}));
