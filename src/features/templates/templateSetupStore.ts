/**
 * Guided template-setup flow state.
 *
 * When a user picks an interactive template (one that pairs with a plugin), the
 * gallery applies the message and hands off here instead of dropping them in a
 * cold editor to wire the plugin by hand. `TemplateSetup` (mounted by `App`)
 * walks them through configuring the paired plugin(s) and writes the resulting
 * `custom_id` onto the right component for them.
 *
 * When they're done the modal simply closes, leaving the editor (and its live
 * preview) in front. The "go post" nudge — pulsing the Send button and raising
 * the mobile preview — is a separate concern handled by `sendNudgeStore`, so
 * this store stays a plain open/close switch like `templateGalleryStore`.
 */

import { create } from "zustand";

interface TemplateSetupState {
  /** Id of the template being set up; null = the flow is closed. */
  templateId: string | null;
  /** Plugin a feature landing promised; its row is ordered first. */
  preferredPluginId: string | null;
  /** Open the setup flow for a template the gallery has just applied. */
  begin(templateId: string, preferredPluginId?: string): void;
  /** Close the setup modal (done / skip / dismiss); leaves the editor in front. */
  close(): void;
}

export const useTemplateSetupStore = create<TemplateSetupState>((set) => ({
  templateId: null,
  preferredPluginId: null,
  begin: (templateId, preferredPluginId) =>
    set({ templateId, preferredPluginId: preferredPluginId ?? null }),
  close: () => set({ templateId: null, preferredPluginId: null }),
}));
