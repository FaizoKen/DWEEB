/**
 * Service-worker update prompt.
 *
 * A freshly deployed service worker precaches in the background and then waits
 * (see the `registerType: "prompt"` rationale in vite.config.ts) so it never
 * hot-swaps chunks under an open tab. When that happens the SW registration in
 * `main.tsx` calls `markReady`, and a Discord-style "Update" button surfaces in
 * the corner (see `UpdatePrompt`). Clicking it runs `apply`, which activates the
 * waiting worker and reloads the page onto the new build.
 *
 * A tiny global store keeps this off prop chains, mirroring the other
 * cross-feature signals (`sendNudgeStore`, `templateGalleryStore`).
 */

import { create } from "zustand";

/** `updateSW` as returned by vite-plugin-pwa's `registerSW`. Passing `true`
 *  skips the waiting phase and reloads once the new worker takes control. */
type UpdateSW = (reloadPage?: boolean) => Promise<void>;

interface UpdateState {
  /** True once a newly deployed worker is installed and waiting to activate. */
  available: boolean;
  /** True while the reload onto the new build is in flight. */
  applying: boolean;
  /** Captured from `registerSW`; null until an update is ready. */
  update: UpdateSW | null;
  /** Called by the SW registration when a new build is waiting. */
  markReady(update: UpdateSW): void;
  /** Activate the waiting worker and reload onto it. No-op until ready. */
  apply(): void;
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  available: false,
  applying: false,
  update: null,
  markReady: (update) => set({ available: true, update }),
  apply: () => {
    const { update, applying } = get();
    if (!update || applying) return;
    set({ applying: true });
    void update(true);
  },
}));
