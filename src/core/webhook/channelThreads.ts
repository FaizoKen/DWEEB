/**
 * Thread lists for the Send panel's thread picker — the threads and forum posts
 * a webhook in a channel can post into, keyed by `guild:channel`.
 *
 * Before this the only way into a thread was its ID, pasted from Discord's
 * "Copy Thread ID" (Developer Mode only), and a forum channel's existing posts
 * were invisible. The proxy reads them through the bot (Manage-Webhooks gated,
 * like the webhook list), so a 403 parks an entry at `denied` and the panel
 * keeps the manual ID field.
 *
 * Thread names are account-scoped data (they come back only because this
 * account manages the server's webhooks), so sign-out clears them.
 */

import { useEffect } from "react";
import { create } from "zustand";
import { registerAccountStateReset } from "@/core/auth/accountScopedState";
import { useAuthStore } from "@/core/auth/authStore";
import { fetchChannelThreads, isAuthError, type ChannelThread } from "@/core/guild/api";

export type ChannelThreadsStatus = "idle" | "loading" | "ready" | "denied" | "error";

/** How long a fetched list is fresh before a passive load re-pulls. Threads
 *  come and go faster than channels, and the proxy's own cache is a minute. */
const TTL_MS = 60_000;

export interface ChannelThreadsEntry {
  status: ChannelThreadsStatus;
  threads: ChannelThread[];
  moreArchived: boolean;
  archivedListed: boolean;
  /** The channel's Discord type, as the proxy read it (null until loaded). */
  channelType: number | null;
  error: string | null;
  fetchedAt: number;
}

const EMPTY: ChannelThreadsEntry = {
  status: "idle",
  threads: [],
  moreArchived: false,
  archivedListed: true,
  channelType: null,
  error: null,
  fetchedAt: 0,
};

interface ChannelThreadsState {
  entries: Record<string, ChannelThreadsEntry>;
  /** Fetch a channel's threads (deduped per channel; cached for {@link TTL_MS}
   *  unless `force`, which also asks the proxy to skip its cache). */
  load: (guildId: string, channelId: string, opts?: { force?: boolean }) => Promise<void>;
  reset: () => void;
}

export function threadsKey(guildId: string, channelId: string): string {
  return `${guildId}:${channelId}`;
}

const inflight = new Map<string, AbortController>();

export const useChannelThreadsStore = create<ChannelThreadsState>((set, get) => ({
  entries: {},

  async load(guildId, channelId, opts = {}) {
    const force = opts.force ?? false;
    const key = threadsKey(guildId, channelId);
    const current = get().entries[key];
    if (inflight.has(key) && !force) return;
    if (!force && current?.status === "ready" && Date.now() - current.fetchedAt < TTL_MS) {
      return;
    }

    inflight.get(key)?.abort();
    const controller = new AbortController();
    inflight.set(key, controller);
    // A refresh keeps the current rows on screen while it loads.
    set((s) => ({
      entries: {
        ...s.entries,
        [key]: { ...(s.entries[key] ?? EMPTY), status: "loading", error: null },
      },
    }));

    const settle = (entry: ChannelThreadsEntry) => {
      if (inflight.get(key) !== controller) return; // superseded or reset
      set((s) => ({ entries: { ...s.entries, [key]: entry } }));
    };

    try {
      const res = await fetchChannelThreads(guildId, channelId, {
        force,
        signal: controller.signal,
      });
      settle({
        status: "ready",
        threads: res.threads,
        moreArchived: res.more_archived,
        archivedListed: res.archived_listed,
        channelType: res.channel_type,
        error: null,
        fetchedAt: Date.now(),
      });
    } catch (e) {
      if (controller.signal.aborted) return;
      if (isAuthError(e)) {
        useAuthStore.getState().markSignedOut();
        return;
      }
      const status =
        e && typeof e === "object" && "status" in e ? (e as { status: number }).status : 0;
      settle({
        ...(get().entries[key] ?? EMPTY),
        status: status === 403 ? "denied" : "error",
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      if (inflight.get(key) === controller) inflight.delete(key);
    }
  },

  reset() {
    for (const c of inflight.values()) c.abort();
    inflight.clear();
    set({ entries: {} });
  },
}));

registerAccountStateReset(() => useChannelThreadsStore.getState().reset());

/**
 * Bind a channel's thread list: loads it (deduped, cached) whenever both ids
 * are set and `enabled`, and returns the entry plus a forced refresh.
 */
export function useChannelThreads(
  guildId: string | null | undefined,
  channelId: string | null | undefined,
  enabled: boolean,
): { entry: ChannelThreadsEntry; refresh: () => void } {
  const key = guildId && channelId ? threadsKey(guildId, channelId) : null;
  const entry = useChannelThreadsStore((s) => (key ? s.entries[key] : undefined)) ?? EMPTY;
  const load = useChannelThreadsStore((s) => s.load);

  useEffect(() => {
    if (!enabled || !guildId || !channelId) return;
    void load(guildId, channelId);
  }, [enabled, guildId, channelId, load]);

  return {
    entry,
    refresh: () => {
      if (guildId && channelId) void load(guildId, channelId, { force: true });
    },
  };
}
