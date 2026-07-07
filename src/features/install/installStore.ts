/**
 * "Install app" dialog store.
 *
 * Owns just the open/close state of the PWA-install dialog. Mirrors the
 * lightweight pattern of `collaborateStore` / `feedbackStore` so any control —
 * the Builder action bar's "More" menu, and anywhere else — can summon it
 * without threading props through `App`.
 */

import { create } from "zustand";

interface InstallState {
  open: boolean;
  openInstall(): void;
  closeInstall(): void;
}

export const useInstallStore = create<InstallState>((set) => ({
  open: false,
  openInstall() {
    set({ open: true });
  },
  closeInstall() {
    set({ open: false });
  },
}));
