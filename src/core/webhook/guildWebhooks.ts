/**
 * Connected-guild webhook list — the auto-detect feed for Send / Restore.
 *
 * This is what the shared bot's **Manage Webhooks** permission buys the builder:
 * enumerating every webhook in a server (with each incoming webhook's recover
 * URL) is the one Discord call that hard-requires it. Send and Restore use this
 * so a manager never has to paste a webhook URL — they pick one that's already
 * there, or create a fresh one in a click.
 *
 * One store, scoped to the *connected* guild (the app connects one at a time).
 * Both panels mount at once inside the Share dialog, so the fetch is shared and
 * deduped here, and an inline create updates the list in place for both. The
 * list is held in memory only (webhook URLs are credentials) and re-fetched
 * past a short TTL or on demand.
 *
 * Access is gated server-side on the signed-in user *also* holding Manage
 * Webhooks (mirroring Discord), so a 403 parks the store at `denied` — the
 * panels then fall back to their manual path (paste a URL / recents) instead of
 * showing the picker.
 */

import { useEffect } from "react";
import { create } from "zustand";
import { useAuthStore } from "@/core/auth/authStore";
import { useGuildStore } from "@/core/guild/guildStore";
import { isProxyConfigured } from "@/core/guild/config";
import { fetchGuildWebhooks, isAuthError, type GuildWebhook } from "@/core/guild/api";

export type GuildWebhooksStatus = "idle" | "loading" | "ready" | "denied" | "error";

/** How long a fetched list is considered fresh before a passive load re-pulls. */
const TTL_MS = 60_000;

interface GuildWebhooksState {
  /** Guild the current data belongs to, or null when never loaded. */
  guildId: string | null;
  status: GuildWebhooksStatus;
  webhooks: GuildWebhook[];
  /** This deployment's own app id, so the picker can flag DWEEB-owned webhooks. */
  dweebAppId: string;
  error: string | null;
  /** A `denied` caused specifically by the *bot* lacking the permission — the
   *  picker offers a re-invite for this, but not for a user-permission denial. */
  canReinvite: boolean;
  fetchedAt: number;

  /** Fetch the guild's webhooks (deduped; cached for {@link TTL_MS} unless
   *  `force`). Safe to call from both panels' mount effects. */
  load: (guildId: string, opts?: { force?: boolean }) => Promise<void>;
  /** Splice a freshly-created webhook into the list without a refetch. */
  upsertLocal: (webhook: GuildWebhook) => void;
}

// Module-scoped in-flight guard so concurrent mounts share one request.
let inflight: { guildId: string; controller: AbortController } | null = null;

export const useGuildWebhooksStore = create<GuildWebhooksState>((set, get) => ({
  guildId: null,
  status: "idle",
  webhooks: [],
  dweebAppId: "",
  error: null,
  canReinvite: false,
  fetchedAt: 0,

  async load(guildId, opts = {}) {
    const force = opts.force ?? false;
    const s = get();

    // Already in flight for this guild — let it settle.
    if (inflight && inflight.guildId === guildId) return;
    // Fresh cached data for this guild — skip the round-trip.
    if (
      !force &&
      s.guildId === guildId &&
      s.status === "ready" &&
      Date.now() - s.fetchedAt < TTL_MS
    ) {
      return;
    }

    inflight?.controller.abort();
    const controller = new AbortController();
    inflight = { guildId, controller };

    // Switching guild blanks the list so a stale server's URLs can't linger;
    // a refresh of the same guild keeps the current rows visible while loading.
    set((prev) => ({
      guildId,
      status: "loading",
      error: null,
      webhooks: prev.guildId === guildId ? prev.webhooks : [],
    }));

    try {
      const res = await fetchGuildWebhooks(guildId, controller.signal);
      if (inflight?.controller !== controller) return; // superseded
      set({
        guildId,
        status: "ready",
        webhooks: res.webhooks,
        dweebAppId: res.dweeb_application_id,
        error: null,
        canReinvite: false,
        fetchedAt: Date.now(),
      });
    } catch (e) {
      if (controller.signal.aborted) return;
      if (isAuthError(e)) {
        useAuthStore.getState().markSignedOut();
        set({ guildId, status: "idle", webhooks: [], error: null });
        return;
      }
      const status =
        e && typeof e === "object" && "status" in e ? (e as { status: number }).status : 0;
      const message = e instanceof Error ? e.message : String(e);
      if (status === 403) {
        // The proxy distinguishes a missing *bot* permission ("re-add the bot")
        // from the user simply not managing the server.
        set({
          guildId,
          status: "denied",
          error: message,
          canReinvite: /re-?add the bot/i.test(message),
        });
      } else {
        set({ guildId, status: "error", error: message });
      }
    } finally {
      if (inflight?.controller === controller) inflight = null;
    }
  },

  upsertLocal(webhook) {
    set((prev) => {
      const without = prev.webhooks.filter((w) => w.id !== webhook.id);
      return { webhooks: [webhook, ...without] };
    });
  },
}));

/**
 * Whether the signed-in user can manage the connected guild's webhooks — the
 * gate for the auto-detect picker, read from the server list the account menu
 * already loaded. Mirrors the proxy's server-side check (which also requires the
 * *bot* to hold the permission, surfaced as `denied` after a fetch).
 */
export function useCanManageGuildWebhooks(): boolean {
  const connectedId = useGuildStore((s) => s.guildId);
  const guilds = useAuthStore((s) => s.guilds);
  return (
    isProxyConfigured() &&
    connectedId !== "" &&
    (guilds.find((g) => g.id === connectedId)?.can_manage_webhooks ?? false)
  );
}

/**
 * Bind the webhook list to the connected guild: triggers a (deduped) load when
 * the user can manage it, and exposes the store slice the picker renders from.
 * Returns `active: false` when there's nothing to auto-detect (no proxy, signed
 * out, no guild, or the user lacks the permission) — callers hide the picker.
 */
export function useGuildWebhooks(): {
  active: boolean;
  connectedId: string;
  status: GuildWebhooksStatus;
  webhooks: GuildWebhook[];
  dweebAppId: string;
  error: string | null;
  canReinvite: boolean;
  reload: () => void;
} {
  const connectedId = useGuildStore((s) => s.guildId);
  const authStatus = useAuthStore((s) => s.status);
  const canManage = useCanManageGuildWebhooks();
  const active = authStatus === "authed" && canManage;

  const status = useGuildWebhooksStore((s) => s.status);
  const guildId = useGuildWebhooksStore((s) => s.guildId);
  const webhooks = useGuildWebhooksStore((s) => s.webhooks);
  const dweebAppId = useGuildWebhooksStore((s) => s.dweebAppId);
  const error = useGuildWebhooksStore((s) => s.error);
  const canReinvite = useGuildWebhooksStore((s) => s.canReinvite);

  useEffect(() => {
    if (!active || !connectedId) return;
    void useGuildWebhooksStore.getState().load(connectedId);
  }, [active, connectedId]);

  // Only surface store data that belongs to the connected guild — during a
  // guild switch the store may still hold the previous one for a tick.
  const matches = guildId === connectedId;
  return {
    active,
    connectedId,
    status: matches ? status : "loading",
    webhooks: matches ? webhooks : [],
    dweebAppId: matches ? dweebAppId : "",
    error: matches ? error : null,
    canReinvite: matches ? canReinvite : false,
    reload: () =>
      connectedId && void useGuildWebhooksStore.getState().load(connectedId, { force: true }),
  };
}
