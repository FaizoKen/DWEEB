/**
 * Connected-guild custom-bot list — shared by the Send dialog's webhook picker
 * and its "create a webhook" cards.
 *
 * A server may register its own Discord application (account menu → Custom bot)
 * so webhooks made under *their* app post under their identity while their
 * components still route back to DWEEB. Both the channel-first picker (to
 * prioritise / label / post-as a custom bot) and the create cards (to offer
 * one-click "create with your bot") need the same registry, so the fetch is
 * cached here, scoped to the connected guild, and deduped across both mounts.
 *
 * Held in memory only and re-fetched past a short TTL. Any failure — the feature
 * being off on this deployment (501), the user not managing the server (403), a
 * signed-out session, or a network blip — collapses to "no custom bots", which
 * is exactly how callers should treat it (the standard DWEEB path stays
 * available regardless).
 */

import { useEffect } from "react";
import { create } from "zustand";
import { registerAccountStateReset } from "@/core/auth/accountScopedState";
import { useAuthStore } from "@/core/auth/authStore";
import { useGuildStore } from "@/core/guild/guildStore";
import { fetchCustomBots, isAuthError, type CustomBotItem } from "@/core/guild/api";

/** How long a fetched list is considered fresh before a passive load re-pulls. */
const TTL_MS = 60_000;

interface GuildCustomBotsState {
  /** Guild the current data belongs to, or null when never loaded. */
  guildId: string | null;
  items: CustomBotItem[];
  loading: boolean;
  fetchedAt: number;
  /** Fetch the guild's custom bots (deduped; cached for {@link TTL_MS} unless
   *  `force`). Safe to call from multiple mounts. */
  load: (guildId: string, opts?: { force?: boolean }) => Promise<void>;
  /** Release the current account's registry rows and cancel its request. */
  reset: () => void;
}

// Module-scoped in-flight guard so concurrent mounts share one request.
let inflight: { guildId: string; controller: AbortController } | null = null;

// Stable empty fallback so consumers' memos/effects don't churn when there's
// nothing to show (signed out, mid-switch).
const EMPTY: CustomBotItem[] = [];

export const useGuildCustomBotsStore = create<GuildCustomBotsState>((set, get) => ({
  guildId: null,
  items: [],
  loading: false,
  fetchedAt: 0,

  async load(guildId, opts = {}) {
    const force = opts.force ?? false;
    const s = get();

    if (inflight && inflight.guildId === guildId) return;
    if (!force && s.guildId === guildId && Date.now() - s.fetchedAt < TTL_MS) return;

    inflight?.controller.abort();
    const controller = new AbortController();
    inflight = { guildId, controller };

    // Switching guild blanks the list so a stale server's bots can't linger; a
    // refresh of the same guild keeps the current items while loading.
    set((prev) => ({
      guildId,
      loading: true,
      items: prev.guildId === guildId ? prev.items : [],
    }));

    try {
      const bots = await fetchCustomBots(guildId, controller.signal);
      if (inflight?.controller !== controller) return; // superseded
      set({ guildId, items: bots.items, loading: false, fetchedAt: Date.now() });
    } catch (e) {
      if (controller.signal.aborted) return;
      if (isAuthError(e)) {
        useAuthStore.getState().markSignedOut();
        return;
      }
      // 501 (feature off), 403 (not a manager), network — all mean "none here".
      set({ guildId, items: [], loading: false, fetchedAt: Date.now() });
    } finally {
      if (inflight?.controller === controller) inflight = null;
    }
  },

  reset() {
    inflight?.controller.abort();
    inflight = null;
    set({ guildId: null, items: [], loading: false, fetchedAt: 0 });
  },
}));

registerAccountStateReset(() => useGuildCustomBotsStore.getState().reset());

/**
 * The connected guild's registered custom bots — triggers a (deduped) load when
 * signed in and a guild is connected, and returns the cached items for it.
 * Returns an empty list when signed out, no guild is connected, or the data
 * belongs to a guild other than the connected one (mid-switch).
 */
export function useGuildCustomBots(): { bots: CustomBotItem[]; loading: boolean } {
  const connectedId = useGuildStore((s) => s.guildId);
  const authed = useAuthStore((s) => s.status === "authed");
  const guildId = useGuildCustomBotsStore((s) => s.guildId);
  const items = useGuildCustomBotsStore((s) => s.items);
  const loading = useGuildCustomBotsStore((s) => s.loading);

  useEffect(() => {
    if (!authed || !connectedId) return;
    void useGuildCustomBotsStore.getState().load(connectedId);
  }, [authed, connectedId]);

  const matches = guildId === connectedId && connectedId !== "";
  return {
    bots: matches && authed ? items : EMPTY,
    loading: matches ? loading : false,
  };
}
