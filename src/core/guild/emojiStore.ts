/**
 * Cross-server custom-emoji store.
 *
 * A webhook message can render a custom emoji from *any* server the bot shares,
 * not just the one currently connected — so the emoji picker pulls emoji from
 * every server the user manages that the bot is in. This store fetches those
 * per-guild lists lazily (only the missing ones, deduped) and keeps them for the
 * session; the proxy caches each guild's emoji, so repeat opens are cheap.
 *
 * Keyed by guild id. Entries are never displayed for a guild the current user
 * can't see (the picker only asks for the user's own bot servers), so there's no
 * need to clear on sign-out.
 */

import { create } from "zustand";
import { fetchGuildEmojis, GuildApiError, type RawEmoji } from "./api";
import { useAuthStore } from "@/core/auth/authStore";
import type { GuildEmoji } from "./types";

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
}

// Module-scoped so dedup survives across store actions / remounts.
const inflight = new Set<string>();

export const useEmojiStore = create<EmojiState>((set, get) => ({
  byGuild: {},
  status: "idle",

  seed(guildId, emojis) {
    if (get().byGuild[guildId]) return;
    set({ byGuild: { ...get().byGuild, [guildId]: emojis } });
  },

  async loadFor(guildIds) {
    const have = get().byGuild;
    const missing = guildIds.filter((id) => !(id in have) && !inflight.has(id));
    if (missing.length === 0) return;
    for (const id of missing) inflight.add(id);
    set({ status: "loading" });

    await Promise.all(
      missing.map(async (id) => {
        try {
          const raw = await fetchGuildEmojis(id);
          set({ byGuild: { ...get().byGuild, [id]: normalizeEmojis(raw) } });
        } catch (e) {
          // A 401 means the session lapsed — hand off to the auth store.
          if (e instanceof GuildApiError && e.status === 401) {
            useAuthStore.getState().markSignedOut();
          }
          // Record an empty list so a failing guild isn't retried in a loop.
          set({ byGuild: { ...get().byGuild, [id]: get().byGuild[id] ?? [] } });
        } finally {
          inflight.delete(id);
        }
      }),
    );

    set({ status: "ready" });
  },
}));
