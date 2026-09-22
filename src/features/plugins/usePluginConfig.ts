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
 * Every one of those refusals is *visible* — a rejected `save` becomes
 * `saveError`, an incompatible iframe `compatibilityError` — because the host
 * renders none of the form and a silent drop is indistinguishable from a dead
 * Save button. For the same reason the handshake is on a deadline
 * ({@link PLUGIN_FRAME_READY_TIMEOUT_MS}): a plugin origin that is down paints
 * an empty frame forever, so `frameState` gives the modal something to show and
 * `retry()` gives the user something to do.
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
  negotiatePluginApiVersion,
  newNonce,
  sanitizeGuildId,
  sanitizeManagementToken,
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
import { isPluginResource } from "@/core/plugins/resources";
import {
  clearPluginEditToken,
  getPluginEditToken,
  setPluginEditToken,
} from "@/core/plugins/editTokenCache";
import {
  resolvePluginResource,
  savedWebhookMetadata,
  type SavedWebhookMetadata,
} from "./pluginData";

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

/**
 * Where the framed config UI is in its handshake:
 *
 *  - `loading` — mounted, but the iframe hasn't said `ready` yet. A
 *    cross-origin frame paints nothing until its own document loads, so the
 *    host must render something over it or the user stares at an empty box.
 *  - `ready` — the iframe answered the handshake; it owns the surface now.
 *  - `timeout` — {@link PLUGIN_FRAME_READY_TIMEOUT_MS} elapsed with no `ready`
 *    (origin down, blocked, or serving a page that doesn't speak the protocol).
 *    A late `ready` still flips this back to `ready`: if the plugin does turn
 *    up, showing it beats keeping the failure notice.
 */
export type PluginFrameState = "loading" | "ready" | "timeout";

interface Result {
  iframeRef: RefObject<HTMLIFrameElement>;
  /** Height the iframe last requested, or null before any resize. */
  height: number | null;
  /** Visible reason the host refused to initialize an incompatible iframe. */
  compatibilityError: string | null;
  /** Visible reason the host refused a `save` the iframe sent back. */
  saveError: string | null;
  /** Handshake state of the framed config UI. */
  frameState: PluginFrameState;
  /** Remount key for the iframe — bumped by {@link Result.retry}. */
  frameKey: number;
  /** Discard the current frame, mount a fresh one and restart the timer. */
  retry(): void;
  /** Cancels document-bound credential prompts whenever the iframe reloads. */
  onIframeLoad(): void;
  /** One selected webhook awaiting an explicit host-side sharing decision. */
  credentialRequest: SavedWebhookMetadata | null;
  /** Complete the pending request and send either the credential or a refusal. */
  respondToCredentialRequest(approved: boolean): void;
}

interface PendingCredentialRequest {
  requestId: string;
  resource: string;
  resourceId: string;
  /** Document-bound channel transferred by the requesting iframe document. */
  port: MessagePort;
  loadGeneration: number;
}

/** Clamp the iframe height to something sane regardless of what the plugin asks.
 *  The upper bound just guards against a misbehaving plugin reporting an absurd
 *  height — the Modal body scrolls, so a tall-but-legitimate form is fine. */
const MIN_HEIGHT = 160;
const MAX_HEIGHT = 2000;

/**
 * How long the host waits for the iframe's `ready` before declaring the plugin
 * unreachable. Generous on purpose: a cold plugin host behind TLS can take a
 * few seconds, and a false "didn't respond" on a frame that is merely slow is
 * worse than a few more seconds of an honest "Loading…".
 */
export const PLUGIN_FRAME_READY_TIMEOUT_MS = 8000;

/** A returned custom_id must fit Discord's cap and carry the plugin's prefix. */
function isValidCustomId(manifest: PluginManifest, customId: string): boolean {
  return (
    customId.length > 0 &&
    customId.length <= LIMITS.BUTTON_CUSTOM_ID &&
    customId.startsWith(manifest.customIdPrefix)
  );
}

/**
 * Copy for a `save` the host refused. It names the plugin because the failure
 * is the plugin's, and it points at the manual escape hatch (the inspector's
 * own action-id field) so the user is never simply stuck.
 */
export function pluginSaveRejectedMessage(pluginName: string): string {
  return `${pluginName} sent back an action ID DWEEB can't use. Try again, or close this and set the ID manually.`;
}

/** Copy for a config frame that never completed the `ready` handshake. */
export function pluginFrameTimeoutMessage(pluginName: string): string {
  return `${pluginName} didn't respond. Retry, or close this and set the action ID manually.`;
}

/**
 * The visible reason to refuse this `save`, or `null` when it's adoptable.
 *
 * A custom_id that doesn't match the plugin's prefix would route nowhere, so it
 * must be rejected — but silently dropping it (which is what the host used to
 * do outside DEV) reads to the user as a dead Save button. Exported so the
 * refusal rule and its copy stay pinned by tests without a DOM.
 */
export function pluginSaveRejection(manifest: PluginManifest, customId: string): string | null {
  return isValidCustomId(manifest, customId) ? null : pluginSaveRejectedMessage(manifest.name);
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
  const [compatibilityError, setCompatibilityError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [frameState, setFrameState] = useState<PluginFrameState>("loading");
  const [frameKey, setFrameKey] = useState(0);
  const [credentialRequest, setCredentialRequest] = useState<SavedWebhookMetadata | null>(null);
  const pendingCredentialRef = useRef<PendingCredentialRequest | null>(null);
  const loadGenerationRef = useRef(0);
  const negotiatedVersionRef = useRef(0);
  const credentialDeniedRef = useRef(false);

  // Stable per-open nonce.
  const nonceRef = useRef<string>(newNonce());

  // Keep callbacks current without resubscribing the message listener.
  const onSaveRef = useRef(onSave);
  const onCancelRef = useRef(onCancel);
  onSaveRef.current = onSave;
  onCancelRef.current = onCancel;

  // Declare the frame unreachable once the handshake window passes. Restarting
  // on `frameKey` is what makes Retry a real retry: a fresh frame gets a fresh
  // deadline. Leaving `loading` cancels the timer through the cleanup.
  useEffect(() => {
    if (frameState !== "loading") return;
    const timer = setTimeout(() => setFrameState("timeout"), PLUGIN_FRAME_READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [frameState, frameKey]);

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
        // The frame is up and talking, whatever the version negotiation below
        // decides — an incompatibility is its own visible error, not a blank
        // box, so the loading/timeout cover comes off either way.
        setFrameState("ready");
        const declaredVersion = manifest.apiVersion ?? 1;
        const iframeVersion =
          typeof data.apiVersion === "number" &&
          Number.isInteger(data.apiVersion) &&
          data.apiVersion >= 1
            ? data.apiVersion
            : 1;
        if (declaredVersion > PLUGIN_API_VERSION) {
          negotiatedVersionRef.current = 0;
          setCompatibilityError(
            `${manifest.name} requires plugin protocol v${declaredVersion}, but this DWEEB build supports up to v${PLUGIN_API_VERSION}.`,
          );
          return;
        }
        if (iframeVersion < declaredVersion) {
          negotiatedVersionRef.current = 0;
          setCompatibilityError(
            `${manifest.name} loaded an older config screen (v${iframeVersion}; v${declaredVersion} is required). Deploy the plugin service before the web host, then reload.`,
          );
          return;
        }
        const negotiatedVersion = negotiatePluginApiVersion(
          PLUGIN_API_VERSION,
          declaredVersion,
          iframeVersion,
        );
        if (negotiatedVersion === null) return;
        negotiatedVersionRef.current = negotiatedVersion;
        setCompatibilityError(null);
        const managementToken =
          negotiatedVersion >= 2 && customId ? getPluginEditToken(customId, manifest.id) : null;
        const init: PluginInitMessage = {
          type: "dweeb:plugin:init",
          nonce,
          apiVersion: negotiatedVersion,
          target,
          ...(customId ? { customId } : {}),
          ...(managementToken ? { managementToken } : {}),
          // A preset only seeds a fresh attach; never override a saved binding.
          ...(!customId && preset ? { preset } : {}),
          theme,
          locale: typeof navigator !== "undefined" ? navigator.language : "en",
        };
        iframeRef.current?.contentWindow?.postMessage(init, postTarget);
        return;
      }

      if (isSaveMessage(data, nonce)) {
        const rejection = pluginSaveRejection(manifest, data.customId);
        if (rejection) {
          // A custom_id that doesn't match the plugin's prefix would route
          // nowhere — reject rather than silently mis-bind the component. The
          // refusal has to be *visible*: dropping it silently left the user
          // clicking the plugin's own Save button to no effect at all.
          if (import.meta.env.DEV) {
            console.warn("[plugins] rejected save: custom_id does not match prefix", {
              plugin: manifest.id,
              prefix: manifest.customIdPrefix,
              got: data.customId,
            });
          }
          setSaveError(rejection);
          return;
        }
        setSaveError(null);
        // Edit access is browser-local and never becomes part of the save
        // result applied to the Discord component. Only a negotiated v2 iframe
        // may populate it, and only in the canonical 256-bit format.
        if (customId && customId !== data.customId) {
          clearPluginEditToken(customId, manifest.id);
        }
        if (negotiatedVersionRef.current >= 2) {
          const managementToken = sanitizeManagementToken(data.managementToken);
          if (managementToken) {
            setPluginEditToken(data.customId, manifest.id, managementToken);
          }
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
        const reply = (result: ReturnType<typeof resolvePluginResource>) => {
          const response: PluginResponseMessage = {
            type: "dweeb:plugin:response",
            nonce,
            requestId: data.requestId,
            resource: data.resource,
            ...(result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error }),
          };
          iframeRef.current?.contentWindow?.postMessage(response, postTarget);
        };

        // Resource access is default-deny per manifest. Being globally known to
        // the protocol is not enough for an iframe to read it.
        if (!isPluginResource(data.resource) || !manifest.resources?.includes(data.resource)) {
          reply({ ok: false, error: "This plugin did not declare access to that resource." });
          return;
        }

        if (data.resource === "savedWebhook") {
          const credentialPort = event.ports[0];
          if (negotiatedVersionRef.current < 2 || !credentialPort) {
            reply({
              ok: false,
              error: "Webhook credentials require plugin protocol v2 and a document-bound channel.",
            });
            return;
          }
          const replyOnCredentialPort = (result: ReturnType<typeof resolvePluginResource>) => {
            const response: PluginResponseMessage = {
              type: "dweeb:plugin:response",
              nonce,
              requestId: data.requestId,
              resource: data.resource,
              ...(result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error }),
            };
            credentialPort.postMessage(response);
            credentialPort.close();
          };
          if (credentialDeniedRef.current) {
            replyOnCredentialPort({
              ok: false,
              error: "Webhook sharing was declined for this config session.",
            });
            return;
          }
          if (!data.resourceId) {
            replyOnCredentialPort({ ok: false, error: "A saved webhook id is required." });
            return;
          }
          if (pendingCredentialRef.current) {
            replyOnCredentialPort({
              ok: false,
              error: "Another webhook permission request is already open.",
            });
            return;
          }
          const metadata = savedWebhookMetadata(data.resourceId);
          if (!metadata) {
            replyOnCredentialPort({
              ok: false,
              error: "That saved webhook is no longer available.",
            });
            return;
          }
          pendingCredentialRef.current = {
            requestId: data.requestId,
            resource: data.resource,
            resourceId: data.resourceId,
            port: credentialPort,
            loadGeneration: loadGenerationRef.current,
          };
          setCredentialRequest(metadata);
          return;
        }

        // `pluginId` scopes the `message` resource's placeholder baking to this
        // plugin's own tokens (see pluginData.ts).
        reply(
          resolvePluginResource(data.resource, {
            target,
            customId,
            pluginId: manifest.id,
            resourceId: data.resourceId,
          }),
        );
        return;
      }
    };

    window.addEventListener("message", handler);
    return () => {
      window.removeEventListener("message", handler);
      pendingCredentialRef.current?.port.close();
      pendingCredentialRef.current = null;
    };
    // manifest.id keys the session; target/customId/preset/theme are part of init.
  }, [manifest, target, customId, preset, theme]);

  const onIframeLoad = () => {
    loadGenerationRef.current += 1;
    // A WindowProxy survives iframe navigation. Never let an approval opened by
    // the previous document release a credential to the replacement document.
    pendingCredentialRef.current?.port.close();
    pendingCredentialRef.current = null;
    setCredentialRequest(null);
    // A new document can't have sent the save we refused; the complaint is stale.
    setSaveError(null);
  };

  const retry = () => {
    setCompatibilityError(null);
    setSaveError(null);
    // The replacement frame reports its own height; until it does, fall back to
    // the default so the cover doesn't sit on a box sized for the dead frame.
    setHeight(null);
    setFrameState("loading");
    setFrameKey((key) => key + 1);
  };

  const respondToCredentialRequest = (approved: boolean) => {
    const pending = pendingCredentialRef.current;
    if (!pending) return;
    if (pending.loadGeneration !== loadGenerationRef.current) {
      pending.port.close();
      pendingCredentialRef.current = null;
      setCredentialRequest(null);
      return;
    }
    const result = approved
      ? resolvePluginResource("savedWebhook", {
          target,
          customId,
          pluginId: manifest.id,
          resourceId: pending.resourceId,
          allowCredential: true,
        })
      : ({ ok: false, error: "You chose not to share that webhook." } as const);
    if (!approved) credentialDeniedRef.current = true;
    const response: PluginResponseMessage = {
      type: "dweeb:plugin:response",
      nonce: nonceRef.current,
      requestId: pending.requestId,
      resource: pending.resource,
      ...(result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error }),
    };
    // The port was created and transferred by the requesting document. Unlike
    // iframe.contentWindow (a navigation-stable WindowProxy), it cannot switch
    // underneath an open confirmation and leak to a replacement document.
    pending.port.postMessage(response);
    pending.port.close();
    pendingCredentialRef.current = null;
    setCredentialRequest(null);
  };

  return {
    iframeRef,
    height,
    compatibilityError,
    saveError,
    frameState,
    frameKey,
    retry,
    onIframeLoad,
    credentialRequest,
    respondToCredentialRequest,
  };
}
