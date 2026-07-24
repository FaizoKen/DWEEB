/**
 * Guild connection store.
 *
 * Owns the currently connected guild and its mapping data (roles, channels,
 * emojis), and orchestrates loading it from the proxy. The design targets a
 * public deployment with many users, so it is deliberate about request volume:
 *
 *  - **Stale-while-revalidate.** Cached data (localStorage) hydrates the store
 *    at startup and renders immediately; a background refresh only fires when
 *    the data is older than `CLIENT_TTL_MS`.
 *  - **Dedup + abort.** At most one request is in flight; switching guilds
 *    aborts the previous fetch so a slow response can't clobber newer state.
 *  - **Graceful degradation.** A failed refresh keeps showing the last good
 *    data (with a surfaced warning) instead of blanking the UI.
 *
 * Components read resolved names through the narrow selector hooks at the
 * bottom (`useRoleInfo` / `useChannelInfo` / `useEmojiInfo`) — each returns a
 * stable reference while the data is unchanged, so a preview with hundreds of
 * mentions doesn't thrash on unrelated store updates.
 */

import { create } from "zustand";
import { useAuthStore } from "@/core/auth/authStore";
import { fetchBootstrap, GuildApiError, type BootstrapResponse } from "./api";
import { isProxyConfigured } from "./config";
import { clearCachedGuildIdentity, rememberGuildIdentity } from "./identityCache";
import {
  CLIENT_TTL_MS,
  clearCachedGuild,
  loadCachedGuild,
  saveCachedGuild,
  saveLastGuildId,
} from "./cache";
import { pushToast } from "@/ui/Toast";
import type { GuildChannel, GuildData, GuildEmoji, GuildRole } from "./types";

export type GuildStatus = "idle" | "loading" | "ready" | "error";

interface GuildState {
  /** The connected guild's id (persisted; "" when none). */
  guildId: string;
  status: GuildStatus;
  data: GuildData | null;
  /** Last error message, or null. Non-null with `status: "ready"` means the
   *  refresh failed but we're still showing the previously cached data. */
  error: string | null;

  /** Connect to (or switch to) a guild and load its mapping data. */
  connect(guildId: string): Promise<void>;
  /** Re-fetch the currently connected guild. Pass `force` on a manual refresh
   *  to bypass the proxy's cache and pull live data. */
  refresh(force?: boolean): Promise<void>;
  /** Forget the current guild and clear cached data. */
  disconnect(): void;
}

/** Build the O(1) lookup records the preview relies on from the proxy's arrays. */
function indexBootstrap(guildId: string, raw: BootstrapResponse, fetchedAt: number): GuildData {
  const roles: GuildRole[] = (raw.roles ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    color: r.color ?? 0,
    position: r.position ?? 0,
    mentionable: r.mentionable ?? false,
  }));

  const channels: GuildChannel[] = (raw.channels ?? []).map((c) => ({
    id: c.id,
    name: c.name ?? "unknown",
    type: c.type,
    position: c.position ?? 0,
    parentId: c.parent_id ?? null,
  }));

  // Custom emojis always carry an id + name; drop the rare null edge cases so
  // downstream lookups never key on undefined.
  const emojis: GuildEmoji[] = (raw.emojis ?? [])
    .filter((e): e is { id: string; name: string; animated?: boolean; available?: boolean } =>
      Boolean(e.id && e.name),
    )
    .map((e) => ({
      id: e.id,
      name: e.name,
      animated: e.animated ?? false,
      available: e.available ?? true,
    }));

  const roleById: Record<string, GuildRole> = {};
  for (const r of roles) roleById[r.id] = r;
  const channelById: Record<string, GuildChannel> = {};
  for (const c of channels) channelById[c.id] = c;
  const emojiById: Record<string, GuildEmoji> = {};
  for (const e of emojis) emojiById[e.id] = e;

  return { guildId, roles, channels, emojis, roleById, channelById, emojiById, fetchedAt };
}

// The single in-flight request, module-scoped so dedup/abort survives across
// store actions. `controller` identity is the source of truth for "is this
// response still the one we want" — a newer load swaps it and aborts the old.
let inflight: { guildId: string; controller: AbortController } | null = null;

/** Shared load routine for both `connect` and `refresh`. */
async function load(
  guildId: string,
  set: (partial: Partial<GuildState>) => void,
  get: () => GuildState,
  force = false,
): Promise<void> {
  // A load already running for this exact guild — let it settle, don't pile on.
  if (inflight && inflight.guildId === guildId) return;
  inflight?.controller.abort();
  const controller = new AbortController();
  inflight = { guildId, controller };

  try {
    const raw = await fetchBootstrap(guildId, controller.signal, force);
    // Superseded by a newer load (guild switched) — discard this result.
    if (inflight?.controller !== controller) return;
    const data = indexBootstrap(guildId, raw, Date.now());
    saveCachedGuild(data);
    // Remember this as the last server so a future sign-in reselects it.
    saveLastGuildId(guildId);
    set({ guildId, status: "ready", data, error: null });
    // Remember the server's name/icon too: the mapping data above hydrates from
    // localStorage on the next load's first frame, but those two only arrive with
    // the user's guild list, two round-trips later (see `identityCache`).
    const entry = useAuthStore.getState().guilds.find((g) => g.id === guildId);
    rememberGuildIdentity(entry);
    const name = entry?.name;
    // `force` is only set by the explicit "Refresh" action, so word the toast
    // for it differently from a first connect/switch.
    pushToast(
      force
        ? name
          ? `Refreshed ${name}`
          : "Server data refreshed"
        : name
          ? `Connected to ${name}`
          : "Server data loaded",
      "success",
    );
  } catch (e) {
    if (controller.signal.aborted) return; // cancelled on purpose
    // A 401 means the login session lapsed: hand off to the auth store, which
    // resets this store and flips the UI back to a sign-in prompt.
    if (e instanceof GuildApiError && e.status === 401) {
      useAuthStore.getState().markSignedOut();
      return;
    }
    const message =
      e instanceof GuildApiError ? e.message : "Couldn't load server data. Try again.";
    // Keep the last good data for this guild if we have it; only hard-fail when
    // there's nothing to show.
    const current = get();
    const keep = current.data?.guildId === guildId ? current.data : null;
    set({ status: keep ? "ready" : "error", error: message, data: keep });
    pushToast(message, "error");
  } finally {
    if (inflight?.controller === controller) inflight = null;
  }
}

const cached = loadCachedGuild();

export const useGuildStore = create<GuildState>((set, get) => ({
  guildId: cached?.guildId ?? "",
  status: cached ? "ready" : "idle",
  data: cached ?? null,
  error: null,

  async connect(rawId) {
    const guildId = rawId.trim();
    if (!guildId) return;
    if (!isProxyConfigured()) {
      set({ status: "error", error: "Server connection isn't configured for this build." });
      return;
    }
    // Switching guilds drops the previous guild's data so its names can't leak
    // into the new one while the fetch is in flight; reconnecting the same guild
    // keeps the current data visible (a refresh, not a reset).
    const current = get();
    const sameGuild = current.data?.guildId === guildId;
    set({ guildId, status: "loading", error: null, data: sameGuild ? current.data : null });
    await load(guildId, set, get);
  },

  async refresh(force = false) {
    const guildId = get().guildId;
    if (!guildId || !isProxyConfigured()) return;
    set({ status: "loading", error: null });
    await load(guildId, set, get, force);
  },

  disconnect() {
    inflight?.controller.abort();
    inflight = null;
    clearCachedGuild();
    clearCachedGuildIdentity();
    set({ guildId: "", status: "idle", data: null, error: null });
  },
}));

/** True when there's no data or it's older than the client freshness window. */
export function isGuildDataStale(): boolean {
  const { data } = useGuildStore.getState();
  return !data || Date.now() - data.fetchedAt > CLIENT_TTL_MS;
}

// ── Narrow selector hooks ──────────────────────────────────────────────────
// Each resolves a single snowflake. The returned object reference is stable
// while `data` is unchanged, so memoized consumers (e.g. a mention deep in the
// preview) don't re-render on unrelated store activity.

export function useRoleInfo(id: string): GuildRole | undefined {
  return useGuildStore((s) => s.data?.roleById[id]);
}

export function useChannelInfo(id: string): GuildChannel | undefined {
  return useGuildStore((s) => s.data?.channelById[id]);
}

export function useEmojiInfo(id: string): GuildEmoji | undefined {
  return useGuildStore((s) => s.data?.emojiById[id]);
}
