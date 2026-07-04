/**
 * Plan store.
 *
 * Holds the signed-in user's DWEEB tier (bundled onto a RoleLogic subscription,
 * see `server/src/entitlement.rs`) and the open/close state of the pricing
 * modal — the same lightweight, prop-free pattern as `feedbackStore`, so any
 * control (the account menu, a maxed-out quota's "Upgrade" link) can summon it.
 *
 * The plan is loaded lazily: `load()` is cheap and idempotent, called when the
 * account panel opens or the pricing modal is summoned. It fails soft — an
 * error just leaves `plan` null (the UI then simply doesn't show a tier badge).
 */

import { create } from "zustand";
import { fetchPlan, isAuthError, type PlanInfo } from "@/core/guild/api";
import { isProxyConfigured } from "@/core/guild/config";

type PlanStatus = "idle" | "loading" | "ready" | "error";

interface PlanState {
  plan: PlanInfo | null;
  status: PlanStatus;
  open: boolean;

  /** Load the plan from the proxy. Skips the network on a warm `ready` unless
   *  `force`. No-op without a configured proxy. */
  load(force?: boolean): Promise<void>;
  /** Open the pricing modal, loading the plan first if it isn't yet. */
  openPricing(): void;
  closePricing(): void;
  /** Drop cached plan state — called on sign-out. */
  reset(): void;
}

export const usePlanStore = create<PlanState>((set, get) => ({
  plan: null,
  status: "idle",
  open: false,

  async load(force = false) {
    if (!isProxyConfigured()) return;
    if (!force && (get().status === "ready" || get().status === "loading")) return;
    set({ status: "loading" });
    try {
      const plan = await fetchPlan();
      // Null = not signed in; keep it null and mark ready so we don't spin.
      set({ plan, status: "ready" });
    } catch (e) {
      // A 401 is "signed out", handled elsewhere; anything else is a soft miss.
      if (isAuthError(e)) set({ plan: null, status: "ready" });
      else set({ status: "error" });
    }
  },

  openPricing() {
    set({ open: true });
    void get().load();
  },

  closePricing() {
    set({ open: false });
  },

  reset() {
    set({ plan: null, status: "idle", open: false });
  },
}));
