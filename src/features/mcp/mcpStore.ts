/**
 * "Connect an AI client" dialog store.
 *
 * Owns just the open/close state, mirroring `installStore` / `collaborateStore`
 * so any control can summon the dialog without threading props through `App`.
 */

import { create } from "zustand";

interface McpState {
  open: boolean;
  openMcp(): void;
  closeMcp(): void;
}

export const useMcpStore = create<McpState>((set) => ({
  open: false,
  openMcp() {
    set({ open: true });
  },
  closeMcp() {
    set({ open: false });
  },
}));
