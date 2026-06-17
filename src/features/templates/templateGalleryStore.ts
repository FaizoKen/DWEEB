/**
 * Template Gallery store.
 *
 * Owns the full-screen gallery's open state. Mirrors the lightweight pattern of
 * `aiStore` (open / openGallery / closeGallery) so any control — the Builder
 * action bar, the Saved menu, or the on-load effect in `App` — can summon the
 * gallery without prop drilling.
 *
 * The gallery is the app's landing screen: it auto-opens when useful (see
 * `App` + `galleryAutoOpen`), surfacing "Continue where you left off", saved
 * messages, and templates so a user can start from a deliberate choice rather
 * than a cold editor.
 */

import { create } from "zustand";

/** Which chip the gallery lands on when opened. Callers that want the user's
 *  saved messages front-and-centre pass "Saved"; everything else defaults to
 *  "All". The gallery reads this once on mount. */
export type GalleryInitialFilter = "All" | "Saved";

interface TemplateGalleryState {
  open: boolean;
  /** Filter to pre-select the next time the gallery opens. */
  initialFilter: GalleryInitialFilter;
  openGallery(filter?: GalleryInitialFilter): void;
  closeGallery(): void;
}

export const useTemplateGalleryStore = create<TemplateGalleryState>((set) => ({
  open: false,
  initialFilter: "All",
  openGallery(filter = "All") {
    set({ open: true, initialFilter: filter });
  },
  closeGallery() {
    set({ open: false });
  },
}));
