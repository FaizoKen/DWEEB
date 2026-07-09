/**
 * Template Gallery store.
 *
 * Owns the full-screen gallery's open state. Mirrors the lightweight pattern of
 * `aiStore` (open / openGallery / closeGallery) so any control — the Builder
 * action bar, the Saved menu, or the on-load effect in `App` — can summon the
 * gallery without prop drilling.
 *
 * The gallery is the app's landing screen: it auto-opens when useful (see
 * `App` + `galleryAutoOpen`), surfacing posted messages, saved messages, and
 * templates so a user can start from a deliberate choice rather than a cold
 * editor.
 */

import { create } from "zustand";

/** Which chip the gallery lands on when opened. Callers that want the user's
 *  browser-local saves front-and-centre pass "Saved", the shared library's
 *  drafts "Server drafts", posted messages "Posted", the server's timed posts
 *  "Scheduled", and templates "Template". When omitted, the gallery asks for
 *  Posted and falls through to the first chip that actually has cards. */
export type GalleryInitialFilter = "Posted" | "Scheduled" | "Saved" | "Server drafts" | "Template";

interface TemplateGalleryState {
  open: boolean;
  /** Filter to pre-select the next time the gallery opens. */
  initialFilter: GalleryInitialFilter;
  openGallery(filter?: GalleryInitialFilter): void;
  closeGallery(): void;
}

export const useTemplateGalleryStore = create<TemplateGalleryState>((set) => ({
  open: false,
  initialFilter: "Posted",
  openGallery(filter = "Posted") {
    set({ open: true, initialFilter: filter });
  },
  closeGallery() {
    set({ open: false });
  },
}));
