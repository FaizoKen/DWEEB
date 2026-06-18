/**
 * Plugin placeholders — message text that follows a plugin's values.
 *
 * A plugin can **declare** named placeholders in its manifest (`{prize}`,
 * `{entries}`, `{winners}`, …). A user drops those tokens into their own message
 * text, and DWEEB renders them so the posted message reflects the plugin's
 * values — at send time (the *first paint*) and live in the preview.
 *
 * Two distinct moments substitute, and only the first lives here:
 *
 *  - **First paint (this module):** at send + in preview, DWEEB replaces each
 *    *declared* token with the per-instance value the plugin handed back on save
 *    (e.g. the real prize), falling back to the manifest `sample` (e.g. `TBD` for
 *    winners that aren't drawn yet). So no raw `{token}` ever reaches Discord.
 *  - **Live render (the plugin):** once posted, only the plugin can keep the
 *    message current — a webhook message is editable solely via an
 *    `UPDATE_MESSAGE` reply to a click on it. The plugin re-renders its own
 *    stored template on each interaction (that's where `{winners}` fills in after
 *    a draw). DWEEB is not involved there.
 *
 * The substitution itself is pure and lossless on unknown tokens (an unrecognised
 * `{…}` is left verbatim, never blanked), mirroring how the giveaway plugin
 * already treats its announcement template. The host keeps the *raw* tokens in
 * the message store — only the outgoing copy is rendered — so the builder, drafts
 * and share links keep the editable `{token}` text.
 *
 * **Two kinds of provider** offer tokens for one message:
 *
 *  - **Core (the host):** server/channel tokens (`{server}`, `{channel}`, …)
 *    available on *every* message with no plugin attached — resolved from the
 *    connected guild (in the preview) and the destination webhook (at send).
 *    These live in {@link CORE_PLACEHOLDERS} and own a *reserved* namespace: a
 *    plugin can't declare a token that shadows one ({@link parsePlaceholders}
 *    drops it), so core tokens always mean the same thing.
 *  - **Plugins:** each attached plugin's declared tokens (`{prize}`, `{winners}`).
 *
 * **Multiple providers on one message** are resolved deterministically:
 * {@link collectMessagePlaceholders} and {@link messagePlaceholders} both walk
 * providers in the same order — core first, then plugins in binding order — and
 * the *first* provider to claim a token wins. The palette groups tokens by their
 * provider so the source is always visible, and dedupes against that same order,
 * so what the user picks is what resolves. When a plugin re-renders the whole
 * message after posting it only knows its *own* tokens, so the host bakes every
 * *foreign* token (other plugins' + core) to its first-paint value into the
 * template the plugin captures ({@link bakeForeignPlaceholders}) — leaving only
 * the plugin's own tokens raw, so a `{server}` next to a `{winners}` doesn't
 * decay back to a literal `{server}` on the giveaway's lazy refresh.
 */

import { ComponentType, type WebhookMessage } from "@/core/schema/types";
import { getPluginPlaceholderValues } from "@/core/state/pluginSummaryCache";
import type { PluginManifest } from "./manifest";
import { pluginBoundComponents } from "./targets";

/** A placeholder a plugin offers, as declared in its manifest. */
export interface PluginPlaceholder {
  /** The token, written `{token}` in message text. `^[a-z0-9_]{1,32}$`. */
  token: string;
  /** Human label for the authoring UI (the insert palette / preview chip). */
  label: string;
  /**
   * What to show before the plugin has a live value — the real value at config
   * time isn't always known to the host (the plugin sends it on save), and a
   * dynamic token like `winners` has no value until later, so the sample is the
   * friendly stand-in (`TBD`, `0`). Optional; a token with neither a sample nor a
   * saved value is left literal.
   */
  sample?: string;
}

/**
 * Resolved server/channel context the core placeholders render from. Every field
 * is optional: the preview knows the connected *server* but not the destination
 * channel (no webhook chosen yet), the send path knows both. A missing field
 * falls back to the token's manifest `sample`.
 */
export interface PlaceholderContext {
  serverName?: string;
  serverId?: string;
  channelName?: string;
  channelId?: string;
}

/**
 * Host-provided placeholders — server/channel info available on *any* message,
 * no plugin required. This is a *reserved* namespace: {@link parsePlaceholders}
 * refuses a plugin token that collides with one of these, so `{server}` always
 * means the server. `{channel_mention}` renders the clickable `<#id>`; the rest
 * are plain text. Samples stand in until a real value is known (channel tokens
 * have no value until send).
 */
export const CORE_PLACEHOLDERS: readonly PluginPlaceholder[] = [
  { token: "server", label: "Server name", sample: "this server" },
  { token: "server_id", label: "Server ID", sample: "this server's ID" },
  { token: "channel", label: "Channel name", sample: "this channel" },
  { token: "channel_id", label: "Channel ID", sample: "this channel's ID" },
  { token: "channel_mention", label: "Channel link", sample: "this channel" },
];

/** The tokens {@link CORE_PLACEHOLDERS} owns — plugins may not redeclare them. */
export const CORE_PLACEHOLDER_TOKENS: ReadonlySet<string> = new Set(
  CORE_PLACEHOLDERS.map((p) => p.token),
);

/** The core token→value pairs known from `context` (omitted tokens fall back to
 *  their sample). `channel_mention` is derived from the channel id. */
function coreValues(context: PlaceholderContext | undefined): Record<string, string> {
  const v: Record<string, string> = {};
  if (!context) return v;
  if (context.serverName) v.server = context.serverName;
  if (context.serverId) v.server_id = context.serverId;
  if (context.channelName) v.channel = context.channelName;
  if (context.channelId) {
    v.channel_id = context.channelId;
    v.channel_mention = `<#${context.channelId}>`;
  }
  return v;
}

/** Token shape: lowercase id, so `{token}` can't collide with Discord markup. */
export const PLACEHOLDER_TOKEN_RE = /^[a-z0-9_]{1,32}$/;
/** Match a `{token}` occurrence in text (the token alone is captured). */
const TOKEN_IN_TEXT_RE = /\{([a-z0-9_]{1,32})\}/g;

const MAX_PLACEHOLDERS = 24;
const MAX_LABEL = 40;
const MAX_SAMPLE = 200;
/** Per-value cap for the static values a plugin sends on save. */
const MAX_VALUE = 200;
const MAX_VALUES = 32;

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/**
 * Parse a manifest's declared `placeholders`, validate-and-drop style: keep only
 * well-formed entries (token matches {@link PLACEHOLDER_TOKEN_RE}, non-empty
 * label), clamp text, dedupe by token, cap the count. Returns `undefined` when
 * nothing usable survives so the manifest stays free of an empty array — exactly
 * how `parseManagedFields` behaves.
 */
export function parsePlaceholders(raw: unknown): PluginPlaceholder[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PluginPlaceholder[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_PLACEHOLDERS) break;
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (!isNonEmptyString(o.token) || !PLACEHOLDER_TOKEN_RE.test(o.token)) continue;
    // The core server/channel namespace is reserved — a plugin can't shadow it,
    // so `{server}` & co. always resolve to the host's value, never a plugin's.
    if (CORE_PLACEHOLDER_TOKENS.has(o.token)) continue;
    if (!isNonEmptyString(o.label)) continue;
    if (seen.has(o.token)) continue;
    seen.add(o.token);
    out.push({
      token: o.token,
      label: o.label.slice(0, MAX_LABEL),
      ...(isNonEmptyString(o.sample) ? { sample: o.sample.slice(0, MAX_SAMPLE) } : {}),
    });
  }
  return out.length ? out : undefined;
}

/**
 * Validate + clamp the static placeholder values a plugin hands back on save
 * (`PluginSaveMessage.values`). Keys must be valid tokens; values are coerced to
 * strings, length-clamped, and stripped of `@everyone`/`@here` so a value can
 * never inject a mass ping into the user's message. Count-capped. Returns
 * `undefined` when nothing usable survives. Never trusts the iframe's shape, like
 * every inbound plugin field.
 */
export function sanitizePlaceholderValues(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, string> = {};
  let n = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= MAX_VALUES) break;
    if (!PLACEHOLDER_TOKEN_RE.test(key)) continue;
    if (typeof value !== "string") continue;
    out[key] = neuterMassPings(value.slice(0, MAX_VALUE));
    n++;
  }
  return n ? out : undefined;
}

/** Defang `@everyone`/`@here` so a substituted value can't ring the channel — a
 *  zero-width space breaks the literal token Discord scans for, leaving the text
 *  readable. Mention safety for `<@id>`/`<@&id>` stays the user's
 *  `allowed_mentions` policy, which the wire layer computes after substitution. */
function neuterMassPings(value: string): string {
  // U+200B zero-width space: breaks the literal `@everyone`/`@here` token Discord
  // scans for, without visibly changing the rendered text.
  return value.replace(/@(everyone|here)/g, `@${String.fromCodePoint(0x200b)}$1`);
}

/**
 * Replace every *known* `{token}` in `text` with its mapped value. An unknown
 * token is left exactly as written (so a stray `{foo}` in prose survives, and a
 * plugin's own un-substituted token isn't blanked). Pure.
 */
export function substituteText(text: string, map: Record<string, string>): string {
  if (text.indexOf("{") === -1) return text;
  return text.replace(TOKEN_IN_TEXT_RE, (whole, token: string) =>
    Object.prototype.hasOwnProperty.call(map, token) ? map[token]! : whole,
  );
}

/**
 * Return a copy of `message` with every Text Display `content` and button
 * `label` run through {@link substituteText}. The store keeps the raw tokens;
 * this is only for the outgoing send payload and the preview. When `map` is empty
 * the original message is returned untouched (no clone) — the common case where
 * no placeholder-declaring plugin is attached. Pure (never mutates the input).
 */
export function substituteMessage(
  message: WebhookMessage,
  map: Record<string, string>,
): WebhookMessage {
  if (isEmptyMap(map)) return message;
  const clone = structuredClone(message);
  for (const top of clone.components) substituteNode(top, map);
  return clone;
}

/** Recurse the (cloned) component tree, substituting the two user-text fields:
 *  Text Display `content` and interactive/link button `label`. Generic descent
 *  into every nested object/array keeps it correct as the schema grows. */
function substituteNode(node: unknown, map: Record<string, string>): void {
  if (Array.isArray(node)) {
    for (const child of node) substituteNode(child, map);
    return;
  }
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  if (o.type === ComponentType.TextDisplay && typeof o.content === "string") {
    o.content = substituteText(o.content, map);
  } else if (o.type === ComponentType.Button && typeof o.label === "string") {
    o.label = substituteText(o.label, map);
  }
  for (const value of Object.values(o)) {
    if (value && typeof value === "object") substituteNode(value, map);
  }
}

function isEmptyMap(map: Record<string, string>): boolean {
  for (const _ in map) return false;
  return true;
}

/**
 * Build the first-paint token→string map for a message. Providers are merged in
 * a fixed order — **core (server/channel) first, then each plugin in binding
 * order** — and the *first* provider to claim a token wins, so the result is
 * deterministic when several providers are attached (and matches the order the
 * insert palette shows). For each core token the value comes from `context`, else
 * its sample; for each plugin token, the per-binding cached value, else the
 * manifest sample. Reads the expendable per-binding cache, so this is the one
 * impure helper here — the substitution functions above stay pure.
 *
 * A token with neither a value nor a sample is omitted, so it renders literally
 * rather than as an empty string.
 */
export function collectMessagePlaceholders(
  message: WebhookMessage,
  plugins: PluginManifest[],
  context?: PlaceholderContext,
): Record<string, string> {
  const map: Record<string, string> = {};
  const claim = (token: string, value: string | undefined) => {
    // First provider wins — never overwrite a token an earlier provider claimed.
    if (typeof value === "string" && !Object.prototype.hasOwnProperty.call(map, token)) {
      map[token] = value;
    }
  };

  // Core provider first: server/channel tokens, on every message.
  const cv = coreValues(context);
  for (const p of CORE_PLACEHOLDERS) {
    claim(p.token, Object.prototype.hasOwnProperty.call(cv, p.token) ? cv[p.token] : p.sample);
  }

  // Then plugins, in binding order.
  for (const { customId, plugin } of pluginBoundComponents(plugins, message)) {
    const declared = plugin.placeholders;
    if (!declared?.length) continue;
    const values = getPluginPlaceholderValues(customId) ?? {};
    for (const p of declared) {
      claim(
        p.token,
        Object.prototype.hasOwnProperty.call(values, p.token) ? values[p.token] : p.sample,
      );
    }
  }
  return map;
}

/** A provider's tokens, shown as one labelled section in the insert palette. */
export interface PlaceholderGroup {
  /** Section heading — "Server & channel" for core, else the plugin's name. */
  source: string;
  items: PluginPlaceholder[];
}

/**
 * The placeholders a user can insert into *this* message, grouped by provider so
 * the source of each token is visible — core server/channel tokens first (always
 * available), then one group per attached plugin. Deduped by token across groups
 * in that same first-wins order, so each token appears once under the provider
 * that will actually resolve it. Drives the editor's `{}` insert dropdown; never
 * empty (core tokens are universal).
 */
export function messagePlaceholders(
  message: WebhookMessage,
  plugins: PluginManifest[],
): PlaceholderGroup[] {
  const groups: PlaceholderGroup[] = [];
  const seen = new Set<string>();
  const take = (items: readonly PluginPlaceholder[]) => {
    const kept: PluginPlaceholder[] = [];
    for (const p of items) {
      if (seen.has(p.token)) continue;
      seen.add(p.token);
      kept.push(p);
    }
    return kept;
  };

  const core = take(CORE_PLACEHOLDERS);
  if (core.length) groups.push({ source: "Server & channel", items: core });

  for (const { plugin } of pluginBoundComponents(plugins, message)) {
    const items = take(plugin.placeholders ?? []);
    if (!items.length) continue;
    // A plugin bound to more than one component shares a single group.
    const existing = groups.find((g) => g.source === plugin.name);
    if (existing) existing.items.push(...items);
    else groups.push({ source: plugin.name, items });
  }
  return groups;
}

/**
 * Render a *foreign-token-baked* copy of `message` for the plugin identified by
 * `ownPluginId` to capture as its live-render template. Every token that plugin
 * does **not** own — other plugins' tokens and the core server/channel tokens —
 * is substituted to its first-paint value; the plugin's *own* tokens are left raw
 * so it can keep re-rendering them after the message is posted. This is what
 * stops a `{server}` (or another plugin's `{status}`) sitting next to a
 * `{winners}` from decaying into a literal `{server}` when the owning plugin
 * lazily re-renders the whole message on the next click. Pure.
 */
export function bakeForeignPlaceholders(
  message: WebhookMessage,
  plugins: PluginManifest[],
  ownPluginId: string,
  context?: PlaceholderContext,
): WebhookMessage {
  const own = new Set<string>();
  for (const p of plugins.find((pl) => pl.id === ownPluginId)?.placeholders ?? []) {
    own.add(p.token);
  }
  const full = collectMessagePlaceholders(message, plugins, context);
  const foreign: Record<string, string> = {};
  for (const token in full) {
    if (!own.has(token)) foreign[token] = full[token]!;
  }
  return substituteMessage(message, foreign);
}
