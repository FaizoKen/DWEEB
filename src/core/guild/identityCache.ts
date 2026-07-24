/**
 * Last-known identity (name + icon) of the connected server.
 *
 * Everything else about the connected guild hydrates synchronously: `guildStore`
 * reads its id — and its whole roles/channels/emojis map — from localStorage on
 * the first frame. Its *name and icon* are the exception: they live only in the
 * signed-in user's guild list, which costs two sequential proxy round-trips
 * (`/auth/me`, then `/api/guilds`). The landing gallery auto-opens during that
 * first frame, so every surface keyed off that list rendered its "no server"
 * fallback for a second or two of each visit and then popped — and a slow or
 * failing `/api/guilds` (or a signed-in user whose list request errors) left the
 * fallback there for good, next to a fully-loaded server library.
 *
 * So we persist just those two fields beside the mapping cache and resolve
 * through: live list → last known identity. The list stays the source of truth —
 * it overwrites this cache whenever it loads, and if the connected guild is
 * missing from a loaded list (left the server, lost access) the cache is dropped
 * rather than left showing a server the user is no longer in.
 *
 * Same conservative localStorage pattern as `cache.ts`: a versioned key, a parse
 * that never throws, and a graceful no-op when storage is unavailable.
 */

import type { PickerGuild } from "./api";

const STORAGE_KEY = "dweeb.guild.identity.v1";

/** The display half of a guild — what a server chip needs to render. */
export interface GuildIdentityInfo {
  id: string;
  name: string;
  /** Discord's icon hash, or null for a server with no icon. */
  icon: string | null;
}

/** Read-through memo, so resolving on a render path costs no storage hit.
 *  `undefined` = not yet hydrated from storage (vs `null` = nothing cached). */
let memo: GuildIdentityInfo | null | undefined;

function read(): GuildIdentityInfo | null {
  if (memo !== undefined) return memo;
  memo = null;
  if (typeof localStorage === "undefined") return memo;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return memo;
    const parsed = JSON.parse(raw) as Partial<GuildIdentityInfo>;
    // Guard the shape: a partial/corrupt entry is discarded, not trusted.
    if (typeof parsed.id !== "string" || !parsed.id || typeof parsed.name !== "string") {
      return memo;
    }
    memo = {
      id: parsed.id,
      name: parsed.name,
      icon: typeof parsed.icon === "string" ? parsed.icon : null,
    };
  } catch {
    // Unavailable / corrupt storage — we just fall back to the live list.
  }
  return memo;
}

/** The cached identity, or null when it's unknown or names a different guild. */
export function cachedGuildIdentity(guildId?: string | null): GuildIdentityInfo | null {
  if (!guildId) return null;
  const cached = read();
  return cached && cached.id === guildId ? cached : null;
}

/** Persist one guild's identity as the last known one. */
export function rememberGuildIdentity(guild: PickerGuild | null | undefined): void {
  if (!guild?.id || !guild.name) return;
  const next: GuildIdentityInfo = { id: guild.id, name: guild.name, icon: guild.icon ?? null };
  const current = read();
  if (
    current &&
    current.id === next.id &&
    current.name === next.name &&
    current.icon === next.icon
  ) {
    return;
  }
  memo = next;
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota / disabled storage — losing this only costs the old pop-in.
  }
}

export function clearCachedGuildIdentity(): void {
  memo = null;
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/**
 * Reconcile the cache against a freshly loaded guild list. The list is
 * authoritative: it refreshes a renamed server / new icon, and a connected guild
 * that isn't in it at all drops the cache instead of pinning a stale chip.
 */
export function syncGuildIdentity(guildId: string, guilds: PickerGuild[]): void {
  if (!guildId) return;
  const live = guilds.find((g) => g.id === guildId);
  if (live) rememberGuildIdentity(live);
  else if (cachedGuildIdentity(guildId)) clearCachedGuildIdentity();
}

/**
 * The identity to display for `guildId`: the live guild list first, then the
 * last known identity for the same id. Returns null when neither knows it, so
 * callers keep their own fallback (a pasted webhook's saved server name, etc.).
 */
export function resolveGuildIdentity(
  guildId: string | null | undefined,
  guilds: PickerGuild[],
): GuildIdentityInfo | null {
  if (!guildId) return null;
  const live = guilds.find((g) => g.id === guildId);
  if (live) return { id: live.id, name: live.name, icon: live.icon ?? null };
  return cachedGuildIdentity(guildId);
}
