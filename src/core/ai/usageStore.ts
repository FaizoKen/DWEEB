/**
 * Built-in AI usage meter (per account).
 *
 * Mirrors `GET /api/ai/usage`: the signed-in user's remaining daily allowance
 * for the built-in relay — user-scoped on Free, the server's pooled allowance
 * when the connected server is Plus/Pro. Loaded lazily when the AI panel is
 * open on the built-in provider and refreshed after each completed send.
 * Registered with the account-scoped reset so sign-out clears it, like every
 * other per-account cache.
 */

import { create } from "zustand";
import { registerAccountStateReset } from "@/core/auth/accountScopedState";
import { isProxyConfigured } from "@/core/guild/config";
import { proxyFetch } from "@/core/net/proxyFetch";

export interface AiUsage {
  tier: "free" | "plus" | "pro";
  /** Which scope binds the numbers below: the user (Free) or the server pool. */
  scope: "user" | "guild";
  requests_used: number;
  /** `null` = unlimited on this deployment's config. */
  requests_limit: number | null;
  tokens_used: number;
  tokens_limit: number | null;
  member_requests_used: number | null;
  member_requests_limit: number | null;
  /** Unix time the daily window resets (midnight UTC). */
  resets_at: number;
}

interface AiUsageState {
  usage: AiUsage | null;
  /** Load (or refresh) the meter. Fails soft — a miss just leaves it hidden. */
  load(guildId?: string): Promise<void>;
  reset(): void;
}

let generation = 0;

export const useAiUsageStore = create<AiUsageState>((set) => ({
  usage: null,

  async load(guildId) {
    if (!isProxyConfigured()) return;
    const gen = generation;
    try {
      const query = guildId?.trim() ? `?guild_id=${encodeURIComponent(guildId.trim())}` : "";
      const res = await proxyFetch(`/api/ai/usage${query}`, { method: "GET" });
      if (!res.ok) {
        // Signed out, feature off, or a transient error — no meter either way.
        if (gen === generation) set({ usage: null });
        return;
      }
      const body = (await res.json()) as AiUsage;
      if (gen !== generation) return;
      if (typeof body?.requests_used === "number") set({ usage: body });
    } catch {
      // Network blip: keep whatever we last knew rather than flashing the
      // meter away mid-session.
    }
  },

  reset() {
    generation += 1;
    set({ usage: null });
  },
}));

registerAccountStateReset(() => useAiUsageStore.getState().reset());
