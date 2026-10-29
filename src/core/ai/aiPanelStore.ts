/**
 * Whether the AI assistant panel is open.
 *
 * Kept apart from `aiStore` because this flag is all the boot path needs — the
 * App's floating button and the preview's tap-to-close read it — while the
 * store behind the chat (settings, transcript, send orchestration, provider
 * metadata) is only exercised once the lazy panel mounts. Sharing one module
 * put every byte of that on the critical bundle.
 */

import { create } from "zustand";

interface AiPanelState {
  open: boolean;
  openPanel(): void;
  closePanel(): void;
}

export const useAiPanelStore = create<AiPanelState>((set) => ({
  open: false,
  openPanel() {
    set({ open: true });
  },
  closePanel() {
    set({ open: false });
  },
}));
