/**
 * Editor UI preferences store.
 *
 * Holds view-only toggles that shape the editor chrome without touching the
 * message document. Right now that's just `advancedMode`, which reveals the
 * raw/technical inspector fields (custom_id, sku_id, emoji id, snowflake lists,
 * component id). Beginners get a clean default; power users flip it on once.
 *
 * The value seeds from localStorage on first load and is written back on every
 * change so the choice survives a refresh.
 */

import { create } from "zustand";
import { loadUiPrefs, saveUiPrefs } from "./prefsStorage";

interface UiPrefsState {
  advancedMode: boolean;
  setAdvancedMode: (on: boolean) => void;
  toggleAdvanced: () => void;
}

export const useUiPrefs = create<UiPrefsState>((set, get) => ({
  advancedMode: loadUiPrefs().advancedMode,
  setAdvancedMode: (on) => {
    set({ advancedMode: on });
    saveUiPrefs({ advancedMode: on });
  },
  toggleAdvanced: () => get().setAdvancedMode(!get().advancedMode),
}));
