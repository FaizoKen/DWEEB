/**
 * Plugin data access — the *only* editor data a plugin iframe can read.
 *
 * A plugin's config UI sometimes needs the user's own builder content to do its
 * job (the Modal Form plugin, for example, lets you pick a saved message to
 * reply with). This resolver is the single, audited gate for that: it answers a
 * fixed allow-list of resources and nothing else.
 *
 * Most resources are pure content. Webhook execute URLs are different: each one
 * embeds a credential. `savedWebhooks` therefore returns labels and opaque local
 * ids only. A plugin can receive one URL through singular `savedWebhook`, but
 * only after the host has shown a confirmation and passes `allowCredential` for
 * that exact id. The manifest gate in `usePluginConfig` is an additional
 * default-deny boundary. Discord OAuth sessions and AI keys are never exposed.
 */

import { useSavedMessagesStore } from "@/core/state/savedMessagesStore";
import { useMessageStore } from "@/core/state/messageStore";
import { useGuildStore } from "@/core/guild/guildStore";
import { guildIconUrl } from "@/core/guild/api";
import { useAuthStore } from "@/core/auth/authStore";
import { stripEditorFields } from "@/core/serialization/normalize";
import { getPlugins } from "@/core/plugins/registry";
import { bakeForeignPlaceholders, type PlaceholderContext } from "@/core/plugins/placeholders";
import { loadHistory } from "@/core/webhook";

export type ResourceResult = { ok: true; data: unknown } | { ok: false; error: string };

interface ResourceContext {
  /** Plugin-facing kind of the component being configured. */
  target: string;
  /** The component's current custom_id, when one exists. */
  customId?: string;
  /**
   * The requesting plugin's manifest id. Used to scope the `message` resource:
   * tokens this plugin owns stay raw (it re-renders them live), every other
   * token is baked to its first-paint value. Absent → no baking.
   */
  pluginId?: string;
  /** Opaque local id used by singular resources such as `savedWebhook`. */
  resourceId?: string;
  /** Set only after the user approves releasing one credential. */
  allowCredential?: boolean;
}

export interface SavedWebhookMetadata {
  id: string;
  name: string;
  channelName?: string;
  guildName?: string;
}

/** Look up safe display data for a credential confirmation. Never returns the URL. */
export function savedWebhookMetadata(id: string): SavedWebhookMetadata | null {
  const entry = loadHistory().find((candidate) => candidate.id === id && !candidate.deletedAt);
  if (!entry) return null;
  return {
    id: entry.id,
    name: entry.name,
    ...(entry.channelName ? { channelName: entry.channelName } : {}),
    ...(entry.guildName ? { guildName: entry.guildName } : {}),
  };
}

/**
 * Server/channel context known while a plugin's config iframe is open: the
 * *connected* guild (the editor's preview server). The destination channel isn't
 * chosen until send, so channel tokens bake to their sample here — see
 * `bakeForeignPlaceholders` and the placeholders module header.
 */
function authoringContext(): PlaceholderContext {
  const { guildId } = useGuildStore.getState();
  if (!guildId) return {};
  const guild = useAuthStore.getState().guilds.find((g) => g.id === guildId);
  const icon = guild ? guildIconUrl(guild.id, guild.icon) : null;
  return {
    serverId: guildId,
    ...(guild?.name ? { serverName: guild.name } : {}),
    ...(icon ? { serverIcon: icon } : {}),
  };
}

export function resolvePluginResource(resource: string, ctx: ResourceContext): ResourceResult {
  switch (resource) {
    case "savedMessages": {
      // The user's named, saved messages (wire-format payloads — pure content,
      // never any webhook/credential). Lets a plugin offer "reply with…".
      const entries = useSavedMessagesStore.getState().entries;
      return {
        ok: true,
        data: entries.map((e) => ({
          id: e.id,
          name: e.name,
          savedAt: e.savedAt,
          payload: e.payload,
        })),
      };
    }
    case "savedWebhooks": {
      // Labels only. A plugin uses the opaque id to request one credential after
      // the user picks it; opening a config iframe never releases execute URLs.
      const entries = loadHistory();
      return {
        ok: true,
        data: entries
          .filter((e) => !e.deletedAt)
          .map((e) => ({
            id: e.id,
            name: e.name,
            channelName: e.channelName,
            guildName: e.guildName,
          })),
      };
    }
    case "savedWebhook": {
      if (!ctx.resourceId) return { ok: false, error: "A saved webhook id is required." };
      if (!ctx.allowCredential) {
        return { ok: false, error: "Permission to share this webhook was not granted." };
      }
      const entry = loadHistory().find(
        (candidate) => candidate.id === ctx.resourceId && !candidate.deletedAt,
      );
      if (!entry) return { ok: false, error: "That saved webhook is no longer available." };
      return { ok: true, data: { id: entry.id, url: entry.url } };
    }
    case "message": {
      // The message currently being built, as the clean Discord wire payload.
      // When a plugin requests it (to capture as its live-render template), bake
      // every token the plugin doesn't own to its first-paint value — so other
      // providers' tokens (core server/channel, another plugin) don't decay to
      // raw `{token}` text when this plugin re-renders the message after posting.
      // The plugin's own tokens stay raw for it to keep rendering.
      const message = useMessageStore.getState().message;
      const baked = ctx.pluginId
        ? bakeForeignPlaceholders(message, getPlugins(), ctx.pluginId, authoringContext())
        : message;
      return { ok: true, data: stripEditorFields(baked) };
    }
    case "component": {
      // Minimal context about the component the plugin is attached to.
      return { ok: true, data: { target: ctx.target, customId: ctx.customId ?? null } };
    }
    case "guild": {
      // The server the editor is currently connected to (id + display name), so
      // a plugin can target "this server" without the user pasting an id. A
      // guild id isn't a secret — it's visible to every member — and no token or
      // session data rides along. `null` means no server is connected yet, which
      // the plugin should treat as "fall back to asking". The name is best-effort
      // from the user's guild picker; absent for a server not in that list.
      const { guildId } = useGuildStore.getState();
      if (!guildId) return { ok: true, data: null };
      const name = useAuthStore.getState().guilds.find((g) => g.id === guildId)?.name ?? null;
      return { ok: true, data: { id: guildId, name } };
    }
    default:
      return { ok: false, error: `Unknown or restricted resource: ${resource}` };
  }
}
