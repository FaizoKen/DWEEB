import React, { createContext, useContext } from "react";

/**
 * Two zoom factors the product-truth components read from context.
 *
 * Every editor/Discord component is authored at the REAL product's CSS metrics
 * (app UI at 14px base from src/styles/tokens.css; the Discord preview at the
 * measured 16px body from preview/*.module.css) and multiplies them by a zoom:
 *
 *  - `UiScale`      — the DWEEB app chrome (tree, action bar, dialogs…)
 *  - `DiscordScale` — Discord surfaces (the message preview, Discord itself)
 *
 * so one number per surface decides how big "the app on screen" is, and the
 * proportions stay the product's. Suggested values:
 *   landscape editor window (whole-window framing, s ≤ 1.14): ui 1.0–1.1, discord 1.1–1.15
 *   portrait stage (540×960 units filmed at s = 2):           ui 1.07,     discord 1.0
 *     → body 32 canvas px, tree rows 30, buttons 28, headings 48 (spec §6 targets)
 * Explicit size props on the legacy primitives still win over the context.
 */
const UiScaleContext = createContext(1);
const DiscordScaleContext = createContext(1);

export const UiScale: React.FC<{ k: number; children: React.ReactNode }> = ({ k, children }) => (
  <UiScaleContext.Provider value={k}>{children}</UiScaleContext.Provider>
);

export const DiscordScale: React.FC<{ k: number; children: React.ReactNode }> = ({ k, children }) => (
  <DiscordScaleContext.Provider value={k}>{children}</DiscordScaleContext.Provider>
);

/** App-chrome zoom; `u(14)` → 14px at the current zoom. */
export const useUi = () => {
  const k = useContext(UiScaleContext);
  return { k, u: (n: number) => n * k };
};

/** Discord-surface zoom; `d(16)` → the measured 16px body at the current zoom. */
export const useDiscord = () => {
  const k = useContext(DiscordScaleContext);
  return { k, d: (n: number) => n * k };
};
