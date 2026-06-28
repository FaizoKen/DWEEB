/**
 * Host side of the plugin config handshake.
 *
 * Owns one iframe session: mints a per-open nonce, listens for messages from
 * the plugin's manifest origin, replies to `ready` with `init`, and surfaces a
 * validated `save` / `cancel` to the caller. Every inbound message is checked
 * three ways before it's trusted — origin, nonce, and (for save) the
 * `customId` shape against the plugin's declared prefix — so a stale or spoofed
 * frame can't drive the editor.
 *
 * The hook is mounted fresh per open by `PluginConfigModal` (keyed on the
 * binding), so the nonce and listeners reset cleanly each time.
 */

import { useEffect, useRef, useState, type RefObject } from "react";
import { LIMITS } from "@/core/schema/limits";
import { pluginOrigin, PLUGIN_API_VERSION, type PluginManifest } from "@/core/plugins/manifest";
import { sanitizeManagedFields, type ManagedFieldValues } from "@/core/plugins/managedFields";
import {
  isCancelMessage,
  isReadyMessage,
  isRequestMessage,
  isResizeMessage,
  isSaveMessage,
  newNonce,
  sanitizeGuildId,
  sanitizeOptions,
  sanitizeSummary,
  type PluginInitMessage,
  type PluginResponseMessage,
  type PluginSelectOption,
  type PluginSummary,
  type PluginTheme,
} from "@/core/plugins/protocol";
import { sanitizePlaceholderValues } from "@/core/plugins/placeholders";
import type { PluginTarget } from "@/core/plugins/targets";
import { isActivityProxiedPlugins } from "@/core/activity/runtime";
import { resolvePluginResource } from "./pluginData";

export interface PluginSaveResult {
  customId: string;
  summary?: PluginSummary;
  /**
   * Sanitized select-menu options the plugin asked the host to wire onto a
   * `string_select`. Only populated for that target; `undefined` otherwise.
   */
  options?: PluginSelectOption[];
  /**
   * Sanitized values for the component fields the plugin declared it owns
   * (`managesFields`). Written onto the component and locked in the inspector.
   * Only ever the fields the manifest declared; `undefined` when none apply.
   */
  fields?: ManagedFieldValues;
  /**
   * The guild this binding targets, when the plugin is guild-scoped. Cached per
   * binding so the Send panel can warn before posting to a different server.
   */
  guildId?: string;
  /**
   * Static placeholder values the plugin resolved at config time (token → value),
   * cached per binding so the host can render the message's `{token}` text at
   * send and in the preview. Sanitized; `undefined` when the plugin sent none.
   */
  values?: Record<string, string>;
}

interface Args {
  manifest: PluginManifest;
  target: PluginTarget;
  /** Current custom_id when editing an existing binding; undefined when fresh. */
  customId?: string;
  /**
   * A manifest preset id to pre-apply on a fresh attach (the user picked it in
   * the library or a template carried it). Ignored when reconfiguring an
   * existing binding (`customId` set) — the saved config wins.
   */
  preset?: string;
  theme: PluginTheme;
  onSave: (result: PluginSaveResult) => void;
  onCancel: () => void;
}

interface Result {
  iframeRef: RefObject<HTMLIFrameElement>;
  /** Height the iframe last requested, or null before any resize. */
  height: number | null;
}

/** Clamp the iframe height to something sane regardless of what the plugin asks.
 *  The upper bound just guards against a misbehaving plugin reporting an absurd
 *  height — the Modal body scrolls, so a tall-but-legitimate form is fine. */
const MIN_HEIGHT = 160;
const MAX_HEIGHT = 2000;

/** A returned custom_id must fit Discord's cap and carry the plugin's prefix. */
function isValidCustomId(manifest: PluginManifest, customId: string): boolean {
  return (
    customId.length > 0 &&
    customId.length <= LIMITS.BUTTON_CUSTOM_ID &&
    customId.startsWith(manifest.customIdPrefix)
  );
}

export function usePluginConfig({
  manifest,
  target,
  customId,
  preset,
  theme,
  onSave,
  onCancel,
}: Args): Result {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);

  // Stable per-open nonce.
  const nonceRef = useRef<string>(newNonce());

  // Keep callbacks current without resubscribing the message listener.
  const onSaveRef = useRef(onSave);
  const onCancelRef = useRef(onCancel);
  onSaveRef.current = onSave;
  onCancelRef.current = onCancel;

  useEffect(() => {
    // Inside a real Activity the plugin is served same-origin through the proxy
    // and sandboxed to an opaque origin, so its messages arrive as origin
    // `"null"` and we must target it with `"*"`. The `event.source` check below is
    // then the real gate. Everywhere else the frame is the plugin's own origin.
    const proxied = isActivityProxiedPlugins();
    const origin = proxied ? "null" : pluginOrigin(manifest);
    const postTarget = proxied ? "*" : origin;
    const nonce = nonceRef.current;

    const handler = (event: MessageEvent) => {
      // Origin gate first: only the plugin's own frame is trusted.
      if (event.origin !== origin) return;
      // And only the frame we actually mounted (defends against sibling frames).
      if (iframeRef.current && event.source !== iframeRef.current.contentWindow) return;

      const data = event.data;

      if (isReadyMessage(data)) {
        const init: PluginInitMessage = {
          type: "dweeb:plugin:init",
          nonce,
          apiVersion: PLUGIN_API_VERSION,
          target,
          ...(customId ? { customId } : {}),
          // A preset only seeds a fresh attach; never override a saved binding.
          ...(!customId && preset ? { preset } : {}),
          theme,
          locale: typeof navigator !== "undefined" ? navigator.language : "en",
        };
        iframeRef.current?.contentWindow?.postMessage(init, postTarget);
        return;
      }

      if (isSaveMessage(data, nonce)) {
        if (!isValidCustomId(manifest, data.customId)) {
          // A custom_id that doesn't match the plugin's prefix would route
          // nowhere — reject rather than silently mis-bind the component.
          if (import.meta.env.DEV) {
            console.warn("[plugins] rejected save: custom_id does not match prefix", {
              plugin: manifest.id,
              prefix: manifest.customIdPrefix,
              got: data.customId,
            });
          }
          return;
        }
        onSaveRef.current({
          customId: data.customId,
          summary: sanitizeSummary(data.summary),
          // Options are only ever wired onto a string select; ignore them for
          // buttons and the snowflake-resolving selects (which have no options).
          options:
            target === "string_select"
              ? sanitizeOptions(data.options, LIMITS.SELECT_OPTIONS)
              : undefined,
          // Only the fields the manifest declared can be set + locked.
          fields: sanitizeManagedFields(data.fields, manifest.managesFields),
          guildId: sanitizeGuildId(data.guildId),
          // Static placeholder values for the message's `{token}` first paint.
          values: sanitizePlaceholderValues(data.values),
        });
        return;
      }

      if (isCancelMessage(data, nonce)) {
        onCancelRef.current();
        return;
      }

      if (isResizeMessage(data, nonce)) {
        setHeight(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(data.height))));
        return;
      }

      if (isRequestMessage(data, nonce)) {
        // The resolver is the audited allow-list; it never returns credentials.
        // `pluginId` scopes the `message` resource's placeholder baking to this
        // plugin's own tokens (see pluginData.ts).
        const result = resolvePluginResource(data.resource, {
          target,
          customId,
          pluginId: manifest.id,
        });
        const response: PluginResponseMessage = {
          type: "dweeb:plugin:response",
          nonce,
          requestId: data.requestId,
          resource: data.resource,
          ...(result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error }),
        };
        iframeRef.current?.contentWindow?.postMessage(response, postTarget);
        return;
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
    // manifest.id keys the session; target/customId/preset/theme are part of init.
  }, [manifest, target, customId, preset, theme]);

  return { iframeRef, height };
}
