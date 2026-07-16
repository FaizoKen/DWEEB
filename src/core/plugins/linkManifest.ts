/**
 * Link-plugin manifest — the contract for a URL-based plugin.
 *
 * A **link plugin** gives a *Link button* its destination. It is the URL-only
 * sibling of the interactive plugins in `manifest.ts`: where those bind through
 * a `custom_id` and receive Discord interactions via the dispatcher, a link
 * plugin is nothing but an `https` URL template served by an external service.
 * Clicking the button opens that URL in the member's browser; everything after
 * that — identifying the member (typically the service's own Discord OAuth),
 * acting on the server (the service's own bot) — happens on the external
 * service, with zero DWEEB involvement.
 *
 * That buys the integration three properties the interactive plugins can't have:
 *
 *  - **No DWEEB backend footprint.** No dispatcher route, no Caddy site, no
 *    compose service, no health check — listing the manifest in `registry.json`
 *    is the entire integration.
 *  - **Works through any webhook.** A Link button carries no `custom_id`, so
 *    the message doesn't have to be posted through an app-owned webhook.
 *  - **Never expires.** The component-TTL rules only govern interactions; a
 *    link keeps working for the life of the message.
 *
 * The binding follows the same philosophy as `custom_id` ownership: DWEEB
 * stores nothing plugin-specific on the message. The button's `url` *is* the
 * binding — on reload of a draft or share link the owning plugin is re-derived
 * by prefix-matching the URL against each manifest's literal template prefix
 * (see {@link matchLinkPlugin}), exactly as `matchPlugin` does for `custom_id`.
 *
 * The template may carry the core `{tokens}` (`{server_id}`, `{channel_id}`, …
 * — see `placeholders.ts`): they substitute at send from the destination
 * webhook, so one registry entry serves every server with no per-guild URL.
 * What usually *is* per-guild is the external service's own configuration
 * (inviting its bot, mapping its settings) — the manifest points at that with
 * `setupUrl`, which the editor surfaces next to the attached chip.
 *
 * A token the webhook *can't* resolve — a value only the admin placing the
 * button knows, like which form a "Fill in the form" button targets — is a
 * **fill-me slot**: the template simply keeps the `{token}` and the admin
 * pastes their finished link (or edits the value in) over the freely-editable
 * URL field. Every plugin gets the exact same UI — chip, Set up, Detach, URL —
 * and {@link unfilledLinkTokens} lets the validator block send while a slot
 * is still raw, so an unfinished button can't post as a dead link.
 *
 * Parsing is validate-and-drop, mirroring `manifest.ts`: a malformed entry
 * simply doesn't appear, it never breaks the app.
 */

import { LIMITS } from "@/core/schema/limits";
import { isAllowedUrl, PLUGIN_MANIFEST_SCHEMA_VERSION } from "./manifest";
import { CORE_PLACEHOLDER_TOKENS } from "./placeholders";
import type { PluginResource } from "./resources";

/** Registry `kind` discriminator for link plugins. Absent means "service". */
export const LINK_PLUGIN_KIND = "link" as const;

export interface LinkPluginManifest {
  /** Manifest shape version. Shared with the service-plugin schema. */
  schemaVersion: typeof PLUGIN_MANIFEST_SCHEMA_VERSION;
  /** Discriminates a link entry from the interactive plugins in the registry. */
  kind: typeof LINK_PLUGIN_KIND;
  /** Stable kebab-case id, unique within the registry. */
  id: string;
  /** Human name shown in the library and the attached chip. */
  name: string;
  /** One-line description shown under the name. */
  description: string;
  /** The service's own semver. Informational. */
  version: string;
  /** Optional https icon URL. */
  icon?: string;
  /** Optional https docs page explaining what the service does. */
  homepage?: string;
  /** Optional publisher/brand label ("via X — external link service"). */
  publisher?: string;
  /**
   * A unicode emoji (or `<:name:id>` custom token) the editor stamps onto the
   * Link button when this plugin is freshly attached to a blank one — the URL
   * sibling of {@link PluginManifest.defaultEmoji}. Never overwrites an emoji
   * the user already set. Absent to leave the button bare.
   */
  defaultEmoji?: string;
  /**
   * The URL template written onto the button — the whole binding. Scheme and
   * host must be literal `https` (tokens only in the path/query), and the
   * literal prefix before the first `{token}` is what re-identifies the plugin
   * on reload, so end it at an unambiguous boundary (a `/`, `?` or `=`).
   * Core `{tokens}` resolve at send from the destination webhook.
   */
  url: string;
  /**
   * The service's admin setup page — where a server manager registers their
   * server (invites the service's bot, configures it) so the button's URL
   * actually does something. Surfaced as a "Set up" action on the attached
   * chip and a "Needs setup" tag in the library. Absent for a service that
   * needs no per-server setup.
   */
  setupUrl?: string;
  /** Optional one-liner shown under the chip instead of the stock setup note. */
  setupHint?: string;
  /**
   * Optional per-server setup probe. An `https` URL template (core tokens
   * only — in practice `{server_id}`) the editor fetches, credential-less,
   * when a server is connected: a `200 {"configured": true|false}` JSON body
   * turns the chip's static "set it up first" note into a live
   * **Ready / Needs setup** state. Anything else (offline service, CORS
   * refusal, missing field) degrades to today's behavior — the probe is
   * strictly best-effort and never blocks anything. See `linkStatus.ts`.
   */
  statusUrl?: string;
  /**
   * Optional configuration iframe — the link analogue of the interactive
   * manifest's `configUrl` (docs/plugins.md long reserved this extension:
   * "a configUrl whose save returns a url instead of a customId"). When
   * present, the attached chip offers **Configure**, and the page speaks the
   * same `dweeb:plugin:*` protocol except that its `save` carries a `url`,
   * which must start with this manifest's own literal template prefix (see
   * {@link isValidLinkSaveUrl}). Absent for a plugin whose fill-me-slot
   * paste flow is enough.
   */
  configUrl?: string;
  /**
   * Editor data the config iframe may request — same default-deny gate as the
   * interactive manifest, but restricted to {@link LINK_PLUGIN_RESOURCES}
   * (content-free context only; a link plugin can never request credentials).
   */
  resources?: PluginResource[];
}

/**
 * The only resources a link plugin's config iframe may declare. Deliberately
 * narrower than the interactive allow-list: a link plugin's save is just a
 * URL, so it gets read-only *context* (which server is connected), never
 * message content or webhook credentials.
 */
export const LINK_PLUGIN_RESOURCES: readonly PluginResource[] = ["guild"];

const MAX_SETUP_HINT = 200;

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Fresh (non-global-state) matcher for `{token}` occurrences in a URL. */
const URL_TOKEN_RE = /\{([a-z0-9_]{1,32})\}/g;

/**
 * Literal part of a URL template before its first `{token}` — the prefix the
 * binding is matched by. A template with no tokens is its own prefix.
 */
export function linkUrlPrefix(url: string): string {
  const i = url.indexOf("{");
  return i === -1 ? url : url.slice(0, i);
}

// Scheme + host must be literal — a token may never rewrite where the link
// points, only parameterize its path/query. `http` is allowed only against
// loopback so a service can be developed locally, mirroring `isAllowedUrl`.
const LITERAL_HOST_RE = /^https:\/\/[^/?#{}\s]+([/?#]|$)/;
const LOCAL_HOST_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?([/?#]|$)/;

/** A usable URL template: bounded, and literal through at least the host. */
function isValidUrlTemplate(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > LIMITS.BUTTON_URL) return false;
  const prefix = linkUrlPrefix(raw);
  return LITERAL_HOST_RE.test(prefix) || LOCAL_HOST_RE.test(prefix);
}

/**
 * Validate-and-drop parse of one link-plugin entry. Returns a clean
 * {@link LinkPluginManifest} or `null` when a required field is missing or
 * malformed. Never throws.
 */
export function parseLinkManifest(raw: unknown): LinkPluginManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  if (o.schemaVersion !== PLUGIN_MANIFEST_SCHEMA_VERSION) return null;
  if (o.kind !== LINK_PLUGIN_KIND) return null;
  if (!isNonEmptyString(o.id) || !isNonEmptyString(o.name)) return null;
  if (!isValidUrlTemplate(o.url)) return null;

  const linkResources = parseLinkResources(o.resources);

  return {
    schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
    kind: LINK_PLUGIN_KIND,
    id: o.id,
    name: o.name,
    description: isNonEmptyString(o.description) ? o.description : "",
    version: isNonEmptyString(o.version) ? o.version : "0.0.0",
    url: o.url,
    ...(isAllowedUrl(o.icon) ? { icon: o.icon } : {}),
    ...(isAllowedUrl(o.homepage) ? { homepage: o.homepage } : {}),
    ...(isNonEmptyString(o.publisher) ? { publisher: o.publisher } : {}),
    ...(isNonEmptyString(o.defaultEmoji) ? { defaultEmoji: o.defaultEmoji.slice(0, 32) } : {}),
    ...(isAllowedUrl(o.setupUrl) ? { setupUrl: o.setupUrl } : {}),
    ...(isNonEmptyString(o.setupHint) ? { setupHint: o.setupHint.slice(0, MAX_SETUP_HINT) } : {}),
    ...(isValidUrlTemplate(o.statusUrl) ? { statusUrl: o.statusUrl } : {}),
    ...(isAllowedUrl(o.configUrl) ? { configUrl: o.configUrl } : {}),
    ...(linkResources ? { resources: linkResources } : {}),
  };
}

/** Parse a link manifest's `resources`, keeping only the link allow-list. */
function parseLinkResources(value: unknown): PluginResource[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const resources = [
    ...new Set(
      value.filter((r): r is PluginResource => LINK_PLUGIN_RESOURCES.includes(r as PluginResource)),
    ),
  ];
  return resources.length ? resources : undefined;
}

/**
 * Parse a registry payload into the valid **link** manifests it contains.
 * Entries without `kind: "link"` belong to `parseRegistryPayload` and are
 * skipped here — the two parsers split one `registry.json` between them.
 */
export function parseLinkRegistryPayload(raw: unknown): LinkPluginManifest[] {
  if (!raw || typeof raw !== "object") return [];
  const o = raw as Record<string, unknown>;
  if (o.schemaVersion !== PLUGIN_MANIFEST_SCHEMA_VERSION) return [];
  if (!Array.isArray(o.plugins)) return [];

  const seen = new Set<string>();
  const out: LinkPluginManifest[] = [];
  for (const entry of o.plugins) {
    const manifest = parseLinkManifest(entry);
    if (!manifest) continue;
    // First registration wins on a duplicate id — keeps the library deterministic.
    if (seen.has(manifest.id)) continue;
    seen.add(manifest.id);
    out.push(manifest);
  }
  return out;
}

/**
 * The link plugin that owns a given button URL, by template-prefix match, or
 * `null`. The URL analogue of `matchPlugin`: the longest matching prefix wins
 * so a more specific plugin isn't shadowed by a broader one on the same host.
 */
export function matchLinkPlugin(
  plugins: LinkPluginManifest[],
  url: string | undefined,
): LinkPluginManifest | null {
  if (!url) return null;
  let best: LinkPluginManifest | null = null;
  let bestLen = 0;
  for (const p of plugins) {
    const prefix = linkUrlPrefix(p.url);
    if (url.startsWith(prefix) && prefix.length > bestLen) {
      best = p;
      bestLen = prefix.length;
    }
  }
  return best;
}

/**
 * The fill-me slots still raw in a link-button URL — every `{token}` that is
 * not a core placeholder (core ones resolve at send from the destination
 * webhook). A non-empty result means the admin hasn't finished the URL yet:
 * the value only they know (a form id, a page slug) is still the literal
 * template token, and clicking the posted button would go nowhere. The
 * validator blocks send on it; pasting the finished link over the URL — the
 * one flow every plugin shares — clears it. Order of appearance, deduped.
 */
export function unfilledLinkTokens(url: string): string[] {
  if (url.indexOf("{") === -1) return [];
  const out: string[] = [];
  for (const m of url.matchAll(URL_TOKEN_RE)) {
    const token = m[1]!;
    if (CORE_PLACEHOLDER_TOKENS.has(token)) continue;
    if (!out.includes(token)) out.push(token);
  }
  return out;
}

/**
 * Is `url` acceptable as the `save` result of this link plugin's config
 * iframe? The URL is the whole binding, so the bar mirrors what the interactive
 * host applies to a returned `custom_id` (length + the plugin's declared
 * prefix):
 *
 *  - bounded by Discord's button-URL cap,
 *  - starts with **this manifest's own literal template prefix** — a config
 *    iframe can refine its own binding (fill the form id, point deeper into
 *    its service) but can never repoint the button at a foreign destination,
 *  - carries no unfilled non-core `{token}` — a save must be a *finished*
 *    URL, not another template (core tokens still resolve at send and are
 *    fine).
 *
 * The prefix check subsumes the https-scheme requirement: a valid template's
 * prefix is already literal-`https` (or localhost in dev).
 */
export function isValidLinkSaveUrl(manifest: LinkPluginManifest, url: unknown): url is string {
  if (typeof url !== "string" || url.length === 0 || url.length > LIMITS.BUTTON_URL) return false;
  if (!url.startsWith(linkUrlPrefix(manifest.url))) return false;
  return unfilledLinkTokens(url).length === 0;
}
