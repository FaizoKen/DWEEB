/**
 * Intro-film store.
 *
 * Owns the welcome video overlay's open state. Mirrors the lightweight pattern
 * of `templateGalleryStore` (open / openWelcome / closeWelcome) so any control
 * — App's first-visit hook or the Builder's More menu — can summon the film
 * without prop drilling. Persistence (the "shown once" record) lives in
 * `welcomeGate` and is written by the auto-open hook, not here: a manual
 * replay must never touch the record.
 */

import { create } from "zustand";

interface WelcomeState {
  open: boolean;
  openWelcome(): void;
  closeWelcome(): void;
}

export const useWelcomeStore = create<WelcomeState>((set) => ({
  open: false,
  openWelcome: () => set({ open: true }),
  closeWelcome: () => set({ open: false }),
}));
