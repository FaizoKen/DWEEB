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
 *
 * It does share that hook's two host-side failure surfaces, for the same
 * reason: a refused `save` becomes a visible `saveError` rather than a Save
 * button that silently does nothing, and the `ready` handshake runs on the
 * shared {@link PLUGIN_FRAME_READY_TIMEOUT_MS} deadline so a dead plugin origin
 * shows a retryable notice instead of an empty frame.
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
import { PLUGIN_FRAME_READY_TIMEOUT_MS, type PluginFrameState } from "./usePluginConfig";

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
  /** Visible reason the host refused a `save` the iframe sent back. */
  saveError: string | null;
  /** Handshake state of the framed config UI (same meaning as the interactive hook's). */
  frameState: PluginFrameState;
  /** Remount key for the iframe — bumped by {@link Result.retry}. */
  frameKey: number;
  /** Discard the current frame, mount a fresh one and restart the timer. */
  retry(): void;
}

const MIN_HEIGHT = 160;
const MAX_HEIGHT = 2000;

/**
 * Copy for a `save` the host refused. The escape hatch differs from the
 * interactive plugin's: a Link button's binding *is* its URL, and that field is
 * always freely editable, so the user can simply paste the finished link.
 */
export function linkSaveRejectedMessage(pluginName: string): string {
  return `${pluginName} sent back a link DWEEB can't use. Try again, or paste the URL yourself.`;
}

/** Copy for a link config frame that never completed the `ready` handshake. */
export function linkFrameTimeoutMessage(pluginName: string): string {
  return `${pluginName} didn't respond. Retry, or paste the URL yourself.`;
}

/**
 * The visible reason to refuse this `save`, or `null` when it's adoptable.
 *
 * A URL outside the plugin's own template prefix (or still carrying an unfilled
 * token) would repoint or dead-end the button. Rejecting it is right; rejecting
 * it *silently* — which is what the host used to do outside DEV — reads to the
 * user as a dead Save button. Exported so the rule and its copy stay pinned by
 * tests without a DOM.
 */
export function linkSaveRejection(manifest: LinkPluginManifest, url: string): string | null {
  return isValidLinkSaveUrl(manifest, url) ? null : linkSaveRejectedMessage(manifest.name);
}

export function useLinkPluginConfig({ manifest, linkUrl, theme, onSave, onCancel }: Args): Result {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [frameState, setFrameState] = useState<PluginFrameState>("loading");
  const [frameKey, setFrameKey] = useState(0);

  // Stable per-open nonce.
  const nonceRef = useRef<string>(newNonce());

  // Keep callbacks current without resubscribing the message listener.
  const onSaveRef = useRef(onSave);
  const onCancelRef = useRef(onCancel);
  onSaveRef.current = onSave;
  onCancelRef.current = onCancel;

  // Same deadline, same reasoning as the interactive hook — the constant is
  // shared so the two config surfaces can't drift to different patiences.
  useEffect(() => {
    if (!manifest.configUrl || frameState !== "loading") return;
    const timer = setTimeout(() => setFrameState("timeout"), PLUGIN_FRAME_READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [manifest.configUrl, frameState, frameKey]);

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
        // `ready` is the only proof this frame is up: without the nonce that
        // `init` carries it could never save, so a page that stays silent is
        // correctly reported as not responding.
        setFrameState("ready");
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
        const rejection = linkSaveRejection(manifest, data.url);
        if (rejection) {
          // A URL outside the plugin's own template prefix (or still carrying
          // an unfilled token) would repoint or dead-end the button — reject
          // rather than adopt it, but say so: a silent drop is a Save button
          // that visibly does nothing.
          if (import.meta.env.DEV) {
            console.warn("[plugins] rejected link save: url fails the manifest prefix check", {
              plugin: manifest.id,
              template: manifest.url,
              got: data.url,
            });
          }
          setSaveError(rejection);
          return;
        }
        setSaveError(null);
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

  const retry = () => {
    setSaveError(null);
    // The replacement frame reports its own height; until it does, fall back to
    // the default so the cover doesn't sit on a box sized for the dead frame.
    setHeight(null);
    setFrameState("loading");
    setFrameKey((key) => key + 1);
  };

  return { iframeRef, height, saveError, frameState, frameKey, retry };
}
