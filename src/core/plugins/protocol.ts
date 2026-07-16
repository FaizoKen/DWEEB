/**
 * postMessage protocol between DWEEB (host) and a plugin's config iframe.
 *
 * The handshake is deliberate and minimal:
 *
 *   iframe → host : ready   { apiVersion }            (iframe booted, send context)
 *   host → iframe : init    { ...context, nonce }     (component kind, current id, theme)
 *   iframe → host : save    { customId, summary?, options?, guildId? }  (adopt id; wire options)
 *   iframe → host : cancel                            (user backed out)
 *   iframe → host : resize  { height }                (optional auto-height)
 *
 * Trust model: the iframe is sandboxed and untrusted. The host only accepts a
 * message when (a) it originates from the plugin's manifest origin and (b) it
 * carries the per-open `nonce` the host minted and sent in `init`. The host
 * additionally re-validates the returned `customId` (length + the plugin's
 * declared `customIdPrefix`) before writing it onto the component — see
 * `features/plugins/usePluginConfig.ts`. The host never evaluates anything the
 * iframe sends.
 *
 * `nonce` round-trips on every iframe→host message after `init` so a second
 * stale iframe (or a spoofed frame on the same origin) can't drive the session.
 */

import { newId } from "@/lib/id";
import type { ManagedFieldValues } from "./managedFields";

/** Theme hint passed to the iframe so it can match the editor's appearance. */
export type PluginTheme = "light" | "dark";

/** Discriminator strings — namespaced so they can't collide with other libs. */
export const PLUGIN_MSG = {
  ready: "dweeb:plugin:ready",
  init: "dweeb:plugin:init",
  save: "dweeb:plugin:save",
  cancel: "dweeb:plugin:cancel",
  resize: "dweeb:plugin:resize",
  /** iframe → host: ask DWEEB for a whitelisted piece of editor data. */
  request: "dweeb:plugin:request",
  /** host → iframe: the answer to a `request`. */
  response: "dweeb:plugin:response",
} as const;

/** A short display summary a plugin may attach so the chip reads nicely. */
export interface PluginSummary {
  label: string;
  description?: string;
  icon?: string;
}

/**
 * A select-menu option a plugin can hand back on save to be wired — and locked —
 * onto the `string_select` it's attached to. Lets a plugin own the whole
 * option list (label + the `value` Discord delivers on use) instead of making
 * the user hand-map each one. Only meaningful for the `string_select` target;
 * the host ignores it for buttons and other selects. Always sanitized by the
 * host before it touches the component — see {@link sanitizeOptions}.
 */
export interface PluginSelectOption {
  label: string;
  /** The value Discord delivers when this option is picked (e.g. a role id). */
  value: string;
  description?: string;
  emoji?: { id?: string | null; name?: string | null; animated?: boolean };
}

// ── iframe → host ────────────────────────────────────────────────────────────

export interface PluginReadyMessage {
  type: typeof PLUGIN_MSG.ready;
  /** Highest protocol version this iframe speaks. */
  apiVersion?: number;
}

export interface PluginSaveMessage {
  type: typeof PLUGIN_MSG.save;
  nonce: string;
  /** The custom_id DWEEB should adopt onto the component. */
  customId: string;
  /** Optional richer label for the attached-plugin chip. */
  summary?: PluginSummary;
  /**
   * Optional select-menu options to wire (and lock) onto a `string_select`, so
   * the user never hand-maps each option's value. Sanitized + clamped by the
   * host; ignored entirely for non-`string_select` targets.
   */
  options?: PluginSelectOption[];
  /**
   * Values for the component fields this plugin declared it owns (the manifest's
   * `managesFields`). The host accepts only declared fields, clamps each to
   * Discord's limits, writes them onto the component, and locks them in the
   * inspector — so a plugin can pin e.g. `min_values`/`max_values` and the user
   * can't widen them and break the binding. Ignored for fields not declared.
   */
  fields?: ManagedFieldValues;
  /**
   * The Discord guild this binding targets, when the plugin is guild-scoped
   * (e.g. Self Role only changes roles in the server it was configured for).
   * The host caches it per binding so the Send panel can warn — before the
   * message is posted — when the destination webhook lives in a *different*
   * server, where the component is dead on arrival. Sanitized by the host;
   * ignored when absent or not a snowflake.
   */
  guildId?: string;
  /**
   * Static values for the placeholders this plugin declared in its manifest
   * (`{prize}` → "a Nitro month"), used by the host to render the message's
   * `{token}` text at send and in the preview (the *first paint*). Keyed by
   * token; sanitized + clamped by the host (`sanitizePlaceholderValues`) and
   * cached per binding alongside the summary. Dynamic tokens with no fixed value
   * (e.g. `winners`) are simply omitted — they fall back to the manifest sample
   * until the plugin renders them live. Ignored when absent.
   */
  values?: Record<string, string>;
  /**
   * Protocol v2 only: the one-time edit credential returned by a stateful
   * plugin create. The host validates and stores it browser-locally; it is
   * never written onto the Discord component or any message payload.
   */
  managementToken?: string;
}

/**
 * The `save` a **link plugin's** config iframe sends — same message type, but
 * the binding it hands back is the button's `url` instead of a `custom_id`
 * (docs/plugins.md: "a configUrl whose save returns a url"). The host
 * validates the URL against the manifest's own template prefix before
 * adopting it (`linkManifest.isValidLinkSaveUrl`). `summary` and `guildId`
 * carry the same meaning as on {@link PluginSaveMessage}; the interactive-only
 * fields (`options`, `fields`, `values`, `managementToken`) don't apply to a
 * Link button and are ignored.
 */
export interface LinkPluginSaveMessage {
  type: typeof PLUGIN_MSG.save;
  nonce: string;
  /** The finished button URL DWEEB should adopt. */
  url: string;
  /** Optional richer label for the attached-plugin chip. */
  summary?: PluginSummary;
  /** The guild this URL was configured for, when guild-scoped. */
  guildId?: string;
}

export interface PluginCancelMessage {
  type: typeof PLUGIN_MSG.cancel;
  nonce: string;
}

export interface PluginResizeMessage {
  type: typeof PLUGIN_MSG.resize;
  nonce: string;
  /** Desired iframe height in CSS pixels. */
  height: number;
}

export interface PluginRequestMessage {
  type: typeof PLUGIN_MSG.request;
  nonce: string;
  /** Correlation id the iframe chooses; echoed back on the response. */
  requestId: string;
  /** Whitelisted resource name (see `features/plugins/pluginData.ts`). */
  resource: string;
  /** Resource-specific id. Required when requesting one saved webhook. */
  resourceId?: string;
}

export type PluginInboundMessage =
  | PluginReadyMessage
  | PluginSaveMessage
  | PluginCancelMessage
  | PluginResizeMessage
  | PluginRequestMessage;

// ── host → iframe ────────────────────────────────────────────────────────────

export interface PluginInitMessage {
  type: typeof PLUGIN_MSG.init;
  /** Echoed back by the iframe on every subsequent message. */
  nonce: string;
  /** Protocol version the host speaks. */
  apiVersion: number;
  /** Plugin-facing component kind (see `targets.ts`). */
  target: string;
  /**
   * The component's current `custom_id`, when editing an existing binding. The
   * plugin parses its own instance reference out of this to reload saved
   * config. Absent / empty when attaching fresh.
   */
  customId?: string;
  /**
   * A manifest preset id the host wants pre-applied (the user picked it in the
   * plugin library or a template carried it). The plugin looks the id up in its
   * own preset table and fills its config form, so the user customizes a working
   * setup instead of a blank one. Only ever sent on a fresh attach (no
   * `customId`); an unknown id is ignored. See {@link PluginManifest.presets}.
   */
  preset?: string;
  theme: PluginTheme;
  /** BCP-47 language tag of the editor UI, best-effort. */
  locale: string;
  /**
   * Protocol v2 only: browser-local edit credential for `customId`, when this
   * browser created or last rebound the instance. Missing means the plugin must
   * create a replacement instance instead of updating the public id in place.
   */
  managementToken?: string;
  /**
   * Set to `"link"` when the host is configuring a **link plugin** (a Link
   * button bound by URL). The iframe's `save` must then carry a `url` instead
   * of a `customId` — see {@link LinkPluginSaveMessage}. Absent for the
   * interactive plugins, which predate the field.
   */
  kind?: "link";
  /**
   * Link plugins only: the button's current URL, when it already carries a
   * finished binding (never the raw template of a fresh attach). The iframe
   * can parse its own instance reference out of it to pre-select the current
   * configuration — the link analogue of `customId`.
   */
  linkUrl?: string;
}

export interface PluginResponseMessage {
  type: typeof PLUGIN_MSG.response;
  nonce: string;
  requestId: string;
  resource: string;
  ok: boolean;
  /** Present when `ok` — the requested data. */
  data?: unknown;
  /** Present when `!ok` — why the request was refused. */
  error?: string;
}

// ── guards ───────────────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object";
}

export function isReadyMessage(v: unknown): v is PluginReadyMessage {
  return isObject(v) && v.type === PLUGIN_MSG.ready;
}

/**
 * Negotiate the highest mutually supported version while requiring the iframe
 * to meet the version its manifest declared. `null` means init must not be sent.
 */
export function negotiatePluginApiVersion(
  hostVersion: number,
  declaredVersion: number,
  iframeVersion: unknown,
): number | null {
  const advertised =
    typeof iframeVersion === "number" && Number.isInteger(iframeVersion) && iframeVersion >= 1
      ? iframeVersion
      : 1;
  if (declaredVersion < 1 || declaredVersion > hostVersion || advertised < declaredVersion) {
    return null;
  }
  return Math.min(hostVersion, declaredVersion, advertised);
}

/** Canonical form of the 256-bit edit credential used by protocol v2. */
export function sanitizeManagementToken(raw: unknown): string | undefined {
  return typeof raw === "string" && /^[0-9a-f]{64}$/.test(raw) ? raw : undefined;
}

/** A save message that carries the expected nonce and a usable customId. */
export function isSaveMessage(v: unknown, nonce: string): v is PluginSaveMessage {
  return (
    isObject(v) &&
    v.type === PLUGIN_MSG.save &&
    v.nonce === nonce &&
    typeof v.customId === "string" &&
    v.customId.length > 0
  );
}

/** A link plugin's save: expected nonce and a non-empty `url` (the binding). */
export function isLinkSaveMessage(v: unknown, nonce: string): v is LinkPluginSaveMessage {
  return (
    isObject(v) &&
    v.type === PLUGIN_MSG.save &&
    v.nonce === nonce &&
    typeof v.url === "string" &&
    v.url.length > 0
  );
}

export function isCancelMessage(v: unknown, nonce: string): v is PluginCancelMessage {
  return isObject(v) && v.type === PLUGIN_MSG.cancel && v.nonce === nonce;
}

export function isResizeMessage(v: unknown, nonce: string): v is PluginResizeMessage {
  return (
    isObject(v) &&
    v.type === PLUGIN_MSG.resize &&
    v.nonce === nonce &&
    typeof v.height === "number" &&
    Number.isFinite(v.height)
  );
}

export function isRequestMessage(v: unknown, nonce: string): v is PluginRequestMessage {
  return (
    isObject(v) &&
    v.type === PLUGIN_MSG.request &&
    v.nonce === nonce &&
    typeof v.requestId === "string" &&
    v.requestId.length > 0 &&
    v.requestId.length <= 128 &&
    typeof v.resource === "string" &&
    v.resource.length > 0 &&
    v.resource.length <= 64 &&
    (v.resourceId === undefined ||
      (typeof v.resourceId === "string" && v.resourceId.length > 0 && v.resourceId.length <= 128))
  );
}

/** Extract a plugin-supplied summary, dropping anything malformed. */
export function sanitizeSummary(raw: unknown): PluginSummary | undefined {
  if (!isObject(raw)) return undefined;
  if (typeof raw.label !== "string" || raw.label.length === 0) return undefined;
  return {
    label: raw.label.slice(0, 80),
    ...(typeof raw.description === "string" ? { description: raw.description.slice(0, 200) } : {}),
    ...(typeof raw.icon === "string" ? { icon: raw.icon } : {}),
  };
}

/** Validate a plugin-supplied guild id — a Discord snowflake — else undefined.
 *  Used for the guild-scoped binding hint (`PluginSaveMessage.guildId`); a
 *  malformed value is simply dropped so the host just skips the cross-guild
 *  check rather than trusting a bogus id. */
export function sanitizeGuildId(raw: unknown): string | undefined {
  return typeof raw === "string" && /^\d{15,25}$/.test(raw) ? raw : undefined;
}

/** Discord's per-field cap for a select option (label/value/description). */
const OPTION_FIELD_MAX = 100;

/**
 * Validate + clamp plugin-supplied select options before they're written onto a
 * component. Drops malformed entries, trims and length-clamps each field to
 * Discord's caps, dedupes by `value` (a select can't carry two options with the
 * same value), and limits the count to `max`. Returns `undefined` when nothing
 * usable survives, so callers can treat "no options" uniformly. As with every
 * inbound plugin field, this never trusts the shape the iframe sent.
 */
export function sanitizeOptions(raw: unknown, max: number): PluginSelectOption[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PluginSelectOption[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= max) break;
    if (!isObject(item)) continue;
    const label = typeof item.label === "string" ? item.label.trim() : "";
    const value = typeof item.value === "string" ? item.value.trim() : "";
    if (!label || !value || seen.has(value)) continue;
    seen.add(value);
    const opt: PluginSelectOption = {
      label: label.slice(0, OPTION_FIELD_MAX),
      value: value.slice(0, OPTION_FIELD_MAX),
    };
    if (typeof item.description === "string" && item.description.trim())
      opt.description = item.description.trim().slice(0, OPTION_FIELD_MAX);
    const emoji = sanitizeEmoji(item.emoji);
    if (emoji) opt.emoji = emoji;
    out.push(opt);
  }
  return out.length ? out : undefined;
}

/** A partial emoji is `{ id }` (custom) or `{ name }` (unicode); anything else
 *  is dropped so a malformed emoji never blocks an otherwise-valid option. */
function sanitizeEmoji(raw: unknown): PluginSelectOption["emoji"] | undefined {
  if (!isObject(raw)) return undefined;
  const id = typeof raw.id === "string" && raw.id ? raw.id : undefined;
  const name = typeof raw.name === "string" && raw.name ? raw.name : undefined;
  if (!id && !name) return undefined;
  return {
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    ...(raw.animated === true ? { animated: true } : {}),
  };
}

/** Mint a fresh per-open session nonce. */
export function newNonce(): string {
  return newId();
}

/** Sandbox flags for the plugin iframe. Same-origin is required so the plugin
 *  can use its own storage/cookies against its backend; scripts/forms enable a
 *  normal config UI. Popups are granted so a plugin can open an external link
 *  (e.g. Self Role's "Add the DWEEB bot" OAuth invite) in a new tab — without
 *  this, the browser silently swallows `target="_blank"` clicks. The popup
 *  escapes the sandbox so the destination (Discord's OAuth flow) loads as a
 *  normal, unsandboxed window. No top-navigation of the host frame or downloads
 *  are granted. */
export const PLUGIN_IFRAME_SANDBOX =
  "allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox";

/** Sandbox flags for the plugin iframe **inside a Discord Activity**, where the
 *  frame is served same-origin through the proxy (see `proxiedPluginConfigUrl`).
 *  `allow-same-origin` is deliberately DROPPED here: on the web app the plugin is
 *  a *different* origin than the editor (so it's isolated even with that flag),
 *  but proxied it shares the host's origin — keeping `allow-same-origin` would let
 *  the untrusted plugin reach into the host's DOM/storage. Without it the frame
 *  gets an opaque origin, restoring the isolation; its `postMessage`s then arrive
 *  with origin `"null"` and the `event.source` check becomes the gate (see
 *  `usePluginConfig.ts`). The proxied page makes no cross-origin/cookie calls (its
 *  API is relayed by the proxy), so nothing of value is lost. */
export const PLUGIN_IFRAME_SANDBOX_PROXIED =
  "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox";
