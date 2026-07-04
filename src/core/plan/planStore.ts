/**
 * Plan store (per-server).
 *
 * Holds the tier of **one server at a time** — the one currently connected in
 * the builder, or the one a per-server dialog is upgrading — plus the open/close
 * state of the pricing modal. Premium is sold per Discord server (MEE6/Dyno-
 * style, see `server/src/stripe.rs`), so the plan is always scoped to a guild.
 * Same lightweight, prop-free pattern as `feedbackStore`, so any control (the
 * account menu, a maxed-out quota's "Upgrade" link) can summon the modal for a
 * specific server.
 *
 * The plan is loaded lazily: `load(guildId)` is cheap and idempotent for the same
 * server, and reloads when the server changes. It fails soft — an error just
 * leaves `plan` null (the UI then simply doesn't show a tier badge).
 */

import { create } from "zustand";
import { fetchGuildPlan, isAuthError, type PlanInfo } from "@/core/guild/api";
import { isProxyConfigured } from "@/core/guild/config";

type PlanStatus = "idle" | "loading" | "ready" | "error";

interface PlanState {
  /** The server the loaded `plan` (and the pricing modal) is for. */
  guildId: string | null;
  plan: PlanInfo | null;
  status: PlanStatus;
  open: boolean;

  /** Load a server's plan from the proxy. Skips the network on a warm `ready`
   *  for the *same* server unless `force`; always reloads for a different one.
   *  No-op without a configured proxy or a guild id. */
  load(guildId: string, force?: boolean): Promise<void>;
  /** Open the pricing modal for a server, loading its plan first. */
  openPricing(guildId: string): void;
  closePricing(): void;
  /** Drop cached plan state — called on sign-out and when disconnecting. */
  reset(): void;
}

export const usePlanStore = create<PlanState>((set, get) => ({
  guildId: null,
  plan: null,
  status: "idle",
  open: false,

  async load(guildId, force = false) {
    if (!isProxyConfigured()) return;
    const id = guildId?.trim();
    if (!id) return;
    const st = get();
    // Same server + already loaded/loading → skip unless forced.
    if (!force && id === st.guildId && (st.status === "ready" || st.status === "loading")) return;
    // Switching servers clears the previous server's tier so we never briefly
    // show it against the new one.
    set({ guildId: id, status: "loading", plan: id === st.guildId ? st.plan : null });
    try {
      const plan = await fetchGuildPlan(id);
      // A newer load for a different server may have superseded this one.
      if (get().guildId !== id) return;
      set({ plan, status: "ready" });
    } catch (e) {
      if (get().guildId !== id) return;
      // A 401 is "signed out"; anything else is a soft miss.
      if (isAuthError(e)) set({ plan: null, status: "ready" });
      else set({ status: "error" });
    }
  },

  openPricing(guildId) {
    set({ open: true });
    void get().load(guildId);
  },

  closePricing() {
    set({ open: false });
  },

  reset() {
    set({ guildId: null, plan: null, status: "idle", open: false });
  },
}));
