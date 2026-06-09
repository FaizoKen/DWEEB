/**
 * Plugin data access — the *only* editor data a plugin iframe can read.
 *
 * A plugin's config UI sometimes needs the user's own builder content to do its
 * job (the Modal Form plugin, for example, lets you pick a saved message to
 * reply with). This resolver is the single, audited gate for that: it answers a
 * fixed allow-list of resources and nothing else.
 *
 * Most resources are pure *content* — the message the user is building, their
 * named saved messages — and carry nothing sensitive. The lone exception is
 * `savedWebhooks`, which returns each saved webhook's execute URL. That URL
 * embeds a bot token, so it is a credential: a forwarding plugin (Modal Form)
 * genuinely needs the real destination to post to, and the only alternative —
 * making the user re-paste a URL they already saved — is the worse UX. The
 * tradeoff is deliberate, but note its weight: this gate auto-answers any plugin
 * iframe with no per-request user gesture, so a plugin can read every saved
 * webhook URL the moment its config opens. The defense is upstream — the plugin
 * registry is bundled and curated (see `registry.ts`); only trusted plugins
 * ship. Still off-limits everywhere here: the Discord OAuth session and AI
 * provider keys. An unknown resource is refused.
 */

import { useSavedMessagesStore } from "@/core/state/savedMessagesStore";
import { useMessageStore } from "@/core/state/messageStore";
import { stripEditorFields } from "@/core/serialization/normalize";
import { loadHistory } from "@/core/webhook";

/** Resources a plugin may request. Anything else is refused. */
export const PLUGIN_RESOURCES = [
  "savedMessages",
  "savedWebhooks",
  "message",
  "component",
] as const;
export type PluginResource = (typeof PLUGIN_RESOURCES)[number];

export type ResourceResult = { ok: true; data: unknown } | { ok: false; error: string };

interface ResourceContext {
  /** Plugin-facing kind of the component being configured. */
  target: string;
  /** The component's current custom_id, when one exists. */
  customId?: string;
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
      // The webhooks saved in this browser, so a forwarding plugin can offer
      // "post submissions to one of your saved webhooks" instead of making the
      // user re-paste a URL. Returns the execute `url` (a credential — see the
      // file header) plus enough metadata to label each one in a picker. Entries
      // a health check found gone on Discord are dropped — they can't receive.
      const entries = loadHistory();
      return {
        ok: true,
        data: entries
          .filter((e) => !e.deletedAt)
          .map((e) => ({
            id: e.id,
            name: e.name,
            url: e.url,
            channelName: e.channelName,
            guildName: e.guildName,
          })),
      };
    }
    case "message": {
      // The message currently being built, as the clean Discord wire payload.
      const message = useMessageStore.getState().message;
      return { ok: true, data: stripEditorFields(message) };
    }
    case "component": {
      // Minimal context about the component the plugin is attached to.
      return { ok: true, data: { target: ctx.target, customId: ctx.customId ?? null } };
    }
    default:
      return { ok: false, error: `Unknown or restricted resource: ${resource}` };
  }
}
