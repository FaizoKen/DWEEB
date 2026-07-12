/**
 * Re-aligning the connected guild to a reloaded message's home server.
 *
 * A posted message carries the server it was posted to (see `RestoredOrigin`).
 * When that differs from the currently-connected guild, the editor's preview
 * resolves `<@&role>` / `<#channel>` / `<:emoji:>` against the *wrong* server's
 * data and falls back to placeholder names — so a reloaded message can look
 * broken even though it isn't. These helpers re-point the connected guild at
 * the message's home server, but only when the signed-in user actually belongs
 * to it (otherwise the proxy can't load its mapping data and a connect would
 * just error). Switching the connected guild never changes where an update
 * lands — that rides solely on the stored webhook URL.
 */

import { useGuildStore } from "./guildStore";
import { useAuthStore } from "@/core/auth/authStore";
import { isProxyConfigured } from "./config";
import { pushToast } from "@/ui/Toast";

/**
 * True when `guildId` names a server the signed-in user belongs to and the
 * proxy is configured — i.e. its roles/channels/emojis can be loaded. Reads
 * stores via `getState()`, so callers that need to react to membership loading
 * should derive it from a subscribed `guilds` list instead.
 */
export function canConnectGuild(guildId: string | undefined): guildId is string {
  if (!guildId || !isProxyConfigured()) return false;
  return useAuthStore.getState().guilds.some((g) => g.id === guildId);
}

/**
 * Re-align the connected guild to a reloaded message's home server when the
 * user belongs to it and isn't already there. No-op (returns false) otherwise.
 * An actual switch announces itself with a quiet toast — every caller is
 * acting on something that lives in that server (a restored message, its
 * posted history, its schedules), and a silently jumping server picker reads
 * as a glitch.
 */
export function alignConnectedGuild(guildId: string | undefined): boolean {
  if (!canConnectGuild(guildId)) return false;
  if (useGuildStore.getState().guildId === guildId) return false;
  void useGuildStore.getState().connect(guildId);
  const name = useAuthStore.getState().guilds.find((g) => g.id === guildId)?.name;
  pushToast(name ? `Switched to ${name}.` : "Switched server.", "info");
  return true;
}
