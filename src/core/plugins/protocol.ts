/**
 * postMessage protocol between DWEEB (host) and a plugin's config iframe.
 *
 * The handshake is deliberate and minimal:
 *
 *   iframe → host : ready   { apiVersion }            (iframe booted, send context)
 *   host → iframe : init    { ...context, nonce }     (component kind, current id, theme)
 *   iframe → host : save    { customId, summary? }    (user saved — adopt this custom_id)
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

// ── iframe → host ────────────────────────────────────────────────────────────

export interface PluginReadyMessage {
  type: typeof PLUGIN_MSG.ready;
  /** Protocol version the plugin speaks. Informational. */
  apiVersion?: number;
}

export interface PluginSaveMessage {
  type: typeof PLUGIN_MSG.save;
  nonce: string;
  /** The custom_id DWEEB should adopt onto the component. */
  customId: string;
  /** Optional richer label for the attached-plugin chip. */
  summary?: PluginSummary;
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
  theme: PluginTheme;
  /** BCP-47 language tag of the editor UI, best-effort. */
  locale: string;
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
    typeof v.resource === "string" &&
    v.resource.length > 0
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

/** Mint a fresh per-open session nonce. */
export function newNonce(): string {
  return newId();
}

/** Sandbox flags for the plugin iframe. Same-origin is required so the plugin
 *  can use its own storage/cookies against its backend; scripts/forms enable a
 *  normal config UI. No top-navigation, popups, or downloads are granted. */
export const PLUGIN_IFRAME_SANDBOX = "allow-scripts allow-forms allow-same-origin";
