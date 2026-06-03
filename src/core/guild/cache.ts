/**
 * Client-side persistence for the last connected guild's mapping data.
 *
 * Caching here is a second layer on top of the proxy's own TTL cache: it lets a
 * refresh/revisit show the server's roles, channels, and emojis instantly (no
 * spinner, no request) and, combined with stale-while-revalidate in the store,
 * keeps a public deployment from re-fetching on every page load. We keep only
 * the single most-recent guild — that's all the "reconnect on refresh" flow
 * needs, and it bounds the storage footprint.
 *
 * Mirrors the conservative localStorage pattern used elsewhere in the app
 * (`prefsStorage`, `settingsStorage`): a versioned key, a parse that never
 * throws, and a graceful no-op when storage is unavailable or quota-limited.
 */

import type { GuildData } from "./types";

const STORAGE_KEY = "dweeb.guild.v1";
/** Last connected guild id. Kept separate from the data cache so it survives a
 *  sign-out (which clears the data) and lets the next sign-in reselect it. */
const LAST_GUILD_KEY = "dweeb.guild.last.v1";

/**
 * How long cached guild data is treated as fresh on the client (ms). The proxy
 * caches for ~60s; a longer client window avoids re-fetching on quick revisits
 * while stale-while-revalidate still refreshes in the background when the panel
 * mounts. 10 minutes balances freshness against request volume at scale.
 */
export const CLIENT_TTL_MS = 10 * 60 * 1000;

export function loadCachedGuild(): GuildData | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<GuildData>;
    // Guard the shape: a partial/corrupt entry is discarded rather than trusted.
    if (
      typeof parsed.guildId !== "string" ||
      !Array.isArray(parsed.roles) ||
      !Array.isArray(parsed.channels) ||
      !Array.isArray(parsed.emojis) ||
      typeof parsed.fetchedAt !== "number"
    ) {
      return null;
    }
    return parsed as GuildData;
  } catch {
    return null;
  }
}

export function saveCachedGuild(data: GuildData): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Quota / disabled storage — losing the cache only costs a re-fetch.
  }
}

export function clearCachedGuild(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** The most recently connected guild id, or null. Survives sign-out by design. */
export function loadLastGuildId(): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const id = localStorage.getItem(LAST_GUILD_KEY);
    return id && id.trim() ? id : null;
  } catch {
    return null;
  }
}

export function saveLastGuildId(guildId: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(LAST_GUILD_KEY, guildId);
  } catch {
    // ignore
  }
}
