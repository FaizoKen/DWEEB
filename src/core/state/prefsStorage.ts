/**
 * Editor UI preferences persistence.
 *
 * These are view-only preferences (not part of the message document), so they
 * live in their own versioned localStorage key, separate from the draft and the
 * AI settings. Mirrors the conservative pattern in `src/core/ai/settingsStorage.ts`:
 * a versioned key, a safe parse that never throws, and a graceful fallback when
 * storage is unavailable or quota-limited.
 */

export interface UiPrefs {
  /** Reveal raw/technical fields (custom_id, sku_id, snowflakes, component id). */
  advancedMode: boolean;
}

const STORAGE_KEY = "dwb.ui.v1";

const DEFAULTS: UiPrefs = {
  advancedMode: false,
};

export function loadUiPrefs(): UiPrefs {
  if (typeof localStorage === "undefined") return DEFAULTS;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULTS;
  try {
    const parsed = JSON.parse(raw) as Partial<UiPrefs>;
    return {
      advancedMode:
        typeof parsed.advancedMode === "boolean" ? parsed.advancedMode : DEFAULTS.advancedMode,
    };
  } catch {
    return DEFAULTS;
  }
}

export function saveUiPrefs(prefs: UiPrefs): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Quota / disabled storage — losing the preference is preferable to throwing.
  }
}
