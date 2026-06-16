/**
 * Template Gallery store.
 *
 * Owns the full-screen gallery's open state. Mirrors the lightweight pattern of
 * `aiStore` (open / openGallery / closeGallery) so any control — the Builder
 * action bar, the Saved menu, or the on-load effect in `App` — can summon the
 * gallery without prop drilling.
 *
 * The gallery is the app's landing screen: it opens on every visit (see `App`),
 * surfacing "Continue where you left off", saved messages, and templates so a
 * user always starts from a deliberate choice rather than a cold editor.
 */

import { create } from "zustand";

interface TemplateGalleryState {
  open: boolean;
  openGallery(): void;
  closeGallery(): void;
}

export const useTemplateGalleryStore = create<TemplateGalleryState>((set) => ({
  open: false,
  openGallery() {
    set({ open: true });
  },
  closeGallery() {
    set({ open: false });
  },
}));
