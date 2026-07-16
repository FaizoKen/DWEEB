/**
 * Host side of a **link plugin's** config handshake.
 *
 * The deliberately small sibling of `usePluginConfig`: same per-open nonce,
 * same origin + source gating, same `dweeb:plugin:*` message names — but the
 * save it accepts carries a `url` (the Link button's whole binding) instead of
 * a `custom_id`, validated against the manifest's own template prefix so the
 * iframe can refine its binding but never repoint the button at a foreign
 * destination. There are no management tokens, no select options, no managed
 * fields, and no credential channel here: a link plugin's resource allow-list
 * is capped at content-free context (`LINK_PLUGIN_RESOURCES`), so the whole
 * credential-port apparatus of the interactive hook intentionally has no
 * counterpart. Kept separate rather than threaded through the interactive
 * hook so that battle-tested path stays untouched.
 */

import { useEffect, useRef, useState, type RefObject } from "react";
import { isValidLinkSaveUrl, type LinkPluginManifest } from "@/core/plugins/linkManifest";
import {
  isCancelMessage,
  isLinkSaveMessage,
  isReadyMessage,
  isRequestMessage,
  isResizeMessage,
  newNonce,
  sanitizeGuildId,
  sanitizeSummary,
  type PluginInitMessage,
  type PluginResponseMessage,
  type PluginSummary,
  type PluginTheme,
} from "@/core/plugins/protocol";
import { isActivityProxiedPlugins } from "@/core/activity/runtime";
import { isPluginResource } from "@/core/plugins/resources";
import { resolvePluginResource } from "./pluginData";

export interface LinkPluginSaveResult {
  /** The validated button URL to adopt — the whole binding. */
  url: string;
  summary?: PluginSummary;
  /** The guild the URL targets, when the plugin is guild-scoped. */
  guildId?: string;
}

interface Args {
  manifest: LinkPluginManifest;
  /**
   * The button's current URL when it already carries a finished binding —
   * passed to the iframe as `init.linkUrl` so it can pre-select the current
   * configuration. Pass `undefined` on a fresh attach (the raw template is
   * not a binding worth echoing).
   */
  linkUrl?: string;
  theme: PluginTheme;
  onSave: (result: LinkPluginSaveResult) => void;
  onCancel: () => void;
}

interface Result {
  iframeRef: RefObject<HTMLIFrameElement>;
  /** Height the iframe last requested, or null before any resize. */
  height: number | null;
}

const MIN_HEIGHT = 160;
const MAX_HEIGHT = 2000;

export function useLinkPluginConfig({ manifest, linkUrl, theme, onSave, onCancel }: Args): Result {
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
    const configUrl = manifest.configUrl;
    if (!configUrl) return;
    // Same origin story as the interactive hook: proxied inside a production
    // Activity (opaque origin, messages arrive as "null"), the plugin's own
    // origin everywhere else. The `event.source` check is the constant gate.
    const proxied = isActivityProxiedPlugins();
    const origin = proxied ? "null" : new URL(configUrl).origin;
    const postTarget = proxied ? "*" : origin;
    const nonce = nonceRef.current;

    const handler = (event: MessageEvent) => {
      if (event.origin !== origin) return;
      if (iframeRef.current && event.source !== iframeRef.current.contentWindow) return;

      const data = event.data;

      if (isReadyMessage(data)) {
        const init: PluginInitMessage = {
          type: "dweeb:plugin:init",
          nonce,
          apiVersion: 1,
          target: "button",
          kind: "link",
          ...(linkUrl ? { linkUrl } : {}),
          theme,
          locale: typeof navigator !== "undefined" ? navigator.language : "en",
        };
        iframeRef.current?.contentWindow?.postMessage(init, postTarget);
        return;
      }

      if (isLinkSaveMessage(data, nonce)) {
        if (!isValidLinkSaveUrl(manifest, data.url)) {
          // A URL outside the plugin's own template prefix (or still carrying
          // an unfilled token) would repoint or dead-end the button — reject
          // rather than adopt it.
          if (import.meta.env.DEV) {
            console.warn("[plugins] rejected link save: url fails the manifest prefix check", {
              plugin: manifest.id,
              template: manifest.url,
              got: data.url,
            });
          }
          return;
        }
        onSaveRef.current({
          url: data.url,
          summary: sanitizeSummary(data.summary),
          guildId: sanitizeGuildId(data.guildId),
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
        // Default-deny, twice over: the resource must be protocol-known AND
        // declared in this manifest — and link manifests can only ever declare
        // the content-free context set (see `LINK_PLUGIN_RESOURCES`).
        const allowed =
          isPluginResource(data.resource) && !!manifest.resources?.includes(data.resource);
        const result = allowed
          ? resolvePluginResource(data.resource, { target: "button" })
          : ({ ok: false, error: "This plugin did not declare access to that resource." } as const);
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
    // manifest.id keys the session; linkUrl/theme are part of init.
  }, [manifest, linkUrl, theme]);

  return { iframeRef, height };
}
