/**
 * Cross-server custom-emoji store.
 *
 * A webhook message can render a custom emoji from *any* server the bot shares,
 * not just the one currently connected — so the emoji picker pulls emoji from
 * every server the user manages that the bot is in. This store fetches those
 * per-guild lists lazily (only the missing ones, deduped) and keeps them for the
 * session; the proxy caches each guild's emoji, so repeat opens are cheap.
 *
 * Keyed by guild id and cleared on sign-out. The picker only asks for servers
 * visible to the current account, and bounded batches keep a large account from
 * fanning out an unbounded number of browser/proxy requests.
 */

import { create } from "zustand";
import { registerAccountStateReset } from "@/core/auth/accountScopedState";
import { fetchGuildEmojis, GuildApiError, type RawEmoji } from "./api";
import { useAuthStore } from "@/core/auth/authStore";
import type { GuildEmoji } from "./types";

/** Enough parallelism for a responsive picker without creating a request storm
 * for accounts that share many servers with the bot. */
const FETCH_CONCURRENCY = 4;

type PermitWaiter = {
  generation: number;
  resolve: (release: (() => void) | null) => void;
};

const activePermits = new Set<symbol>();
const permitWaiters: PermitWaiter[] = [];

function createPermit(): () => void {
  const token = Symbol("emoji-fetch");
  activePermits.add(token);
  return () => {
    if (!activePermits.delete(token)) return;
    drainPermitWaiters();
  };
}

function drainPermitWaiters(): void {
  while (activePermits.size < FETCH_CONCURRENCY && permitWaiters.length > 0) {
    const waiter = permitWaiters.shift()!;
    if (waiter.generation !== accountGeneration) {
      waiter.resolve(null);
      continue;
    }
    waiter.resolve(createPermit());
  }
}

function acquireFetchPermit(generation: number): Promise<(() => void) | null> {
  if (generation !== accountGeneration) return Promise.resolve(null);
  if (activePermits.size < FETCH_CONCURRENCY) return Promise.resolve(createPermit());
  return new Promise((resolve) => permitWaiters.push({ generation, resolve }));
}

/** Normalize the proxy's raw emoji shapes, dropping the rare null edge cases. */
function normalizeEmojis(raw: RawEmoji[]): GuildEmoji[] {
  return (raw ?? [])
    .filter((e): e is { id: string; name: string; animated?: boolean; available?: boolean } =>
      Boolean(e.id && e.name),
    )
    .map((e) => ({
      id: e.id,
      name: e.name,
      animated: e.animated ?? false,
      available: e.available ?? true,
    }));
}

type EmojiStatus = "idle" | "loading" | "ready";

interface EmojiState {
  /** guildId → that server's custom emoji. */
  byGuild: Record<string, GuildEmoji[]>;
  status: EmojiStatus;
  /** Pre-seed a guild's emoji we already have loaded (the connected server). */
  seed(guildId: string, emojis: GuildEmoji[]): void;
  /** Fetch emoji for each given guild that isn't loaded or in flight yet. */
  loadFor(guildIds: string[]): Promise<void>;
  /** Release account-scoped emoji and cancel outstanding requests. */
  reset(): void;
}

// Module-scoped so dedup/cancellation survives across store actions / remounts.
const inflight = new Map<string, AbortController>();
let accountGeneration = 0;

export const useEmojiStore = create<EmojiState>((set, get) => ({
  byGuild: {},
  status: "idle",

  seed(guildId, emojis) {
    if (get().byGuild[guildId]) return;
    set({ byGuild: { ...get().byGuild, [guildId]: emojis } });
  },

  async loadFor(guildIds) {
    const have = get().byGuild;
    const missing = [...new Set(guildIds.map((id) => id.trim()).filter(Boolean))].filter(
      (id) => !(id in have) && !inflight.has(id),
    );
    if (missing.length === 0) return;
    const generation = accountGeneration;
    for (const id of missing) inflight.set(id, new AbortController());
    set({ status: "loading" });

    for (let offset = 0; offset < missing.length; offset += FETCH_CONCURRENCY) {
      if (generation !== accountGeneration) return;
      const batch = missing.slice(offset, offset + FETCH_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (id): Promise<[string, GuildEmoji[]] | null> => {
          const controller = inflight.get(id);
          if (!controller) return null;
          const release = await acquireFetchPermit(generation);
          if (!release) return null;
          try {
            const raw = await fetchGuildEmojis(id, controller.signal);
            return [id, normalizeEmojis(raw)];
          } catch (e) {
            // A 401 invalidates every account-scoped store. That reset also
            // aborts the other emoji requests in this batch.
            if (
              generation === accountGeneration &&
              e instanceof GuildApiError &&
              e.status === 401
            ) {
              useAuthStore.getState().markSignedOut();
              return null;
            }
            // Remember ordinary failures for this account so repeatedly opening
            // the picker does not hammer a failing guild.
            return [id, []];
          } finally {
            release();
            if (inflight.get(id) === controller) inflight.delete(id);
          }
        }),
      );

      // A sign-out (and a later sign-in to the same guilds) must never accept a
      // delayed response from the previous account lifetime.
      if (generation !== accountGeneration) return;
      const loaded = Object.fromEntries(results.filter((item) => item !== null));
      if (Object.keys(loaded).length > 0) {
        set((state) => ({
          byGuild: { ...state.byGuild, ...loaded },
          status: inflight.size === 0 ? "ready" : "loading",
        }));
      }
    }

    if (generation === accountGeneration) {
      set({ status: inflight.size === 0 ? "ready" : "loading" });
    }
  },

  reset() {
    accountGeneration += 1;
    for (const controller of inflight.values()) controller.abort();
    inflight.clear();
    // Queued requests have not reached fetch yet, so retire them immediately.
    // Active requests retain their permits until AbortSignal settles them,
    // keeping the process-wide network bound honest across account changes.
    for (const waiter of permitWaiters.splice(0)) waiter.resolve(null);
    set({ byGuild: {}, status: "idle" });
  },
}));

registerAccountStateReset(() => useEmojiStore.getState().reset());
