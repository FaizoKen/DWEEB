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
 * **user param**: declared in `params`, rendered as an input next to the
 * attached chip, and spliced into the URL as its typed (URI-encoded). The URL
 * stays the whole binding: {@link readLinkParams} parses the values straight
 * back out of it on reload, and a still-raw `{token}` is the visible,
 * validator-flaggable "unfinished" state — instead of a stub URL that posts
 * fine and quietly goes nowhere.
 *
 * Parsing is validate-and-drop, mirroring `manifest.ts`: a malformed entry
 * simply doesn't appear, it never breaks the app. The one escalation: a
 * template token that is neither core nor a declared param could *never*
 * resolve, so it invalidates the whole entry rather than shipping a button
 * that sends members to a literal `{token}`.
 */

import { LIMITS } from "@/core/schema/limits";
import { isAllowedUrl, PLUGIN_MANIFEST_SCHEMA_VERSION } from "./manifest";
import { CORE_PLACEHOLDER_TOKENS, PLACEHOLDER_TOKEN_RE } from "./placeholders";

/** Registry `kind` discriminator for link plugins. Absent means "service". */
export const LINK_PLUGIN_KIND = "link" as const;

/**
 * A user-supplied URL parameter — a `{token}` in the template whose value only
 * the admin placing the button knows (a form id, a page slug), as opposed to
 * the core tokens the webhook resolves at send. The editor renders one input
 * per param next to the attached chip; the typed value is URI-encoded into the
 * button URL and read back from it, so the URL remains the entire binding.
 */
export interface LinkPluginParam {
  /** The template token this param fills, written `{token}` in `url`. */
  token: string;
  /** Input label ("Form ID"). Also how validation names a missing value. */
  label: string;
  /** One-liner under the input — where the admin finds the value. */
  hint?: string;
  /** Example text shown inside the empty input. */
  placeholder?: string;
  /**
   * Anchored regex source the (decoded) value must match — a typo tripwire,
   * not security: the value is URI-encoded on write regardless. A pattern that
   * doesn't compile drops the whole manifest, same as a misplaced token.
   */
  pattern?: string;
}

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
   * User-supplied params for the non-core `{tokens}` in `url`, in declaration
   * order. Every non-core token in the template must be declared here (and
   * every declared token must appear in the template, once, at a delimited
   * position) or the entry is dropped — see {@link parseLinkParams}.
   */
  params?: LinkPluginParam[];
}

const MAX_SETUP_HINT = 200;
const MAX_PARAMS = 4;
const MAX_PARAM_LABEL = 40;
const MAX_PARAM_HINT = 200;
const MAX_PARAM_PLACEHOLDER = 60;
const MAX_PARAM_PATTERN = 200;

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Fresh (non-global-state) matcher for `{token}` occurrences in a template. */
const TEMPLATE_TOKEN_RE = /\{([a-z0-9_]{1,32})\}/g;

/**
 * True when `{token}` sits at an unambiguous spot in the template: exactly one
 * occurrence, entered from a `/`, `?`, `&` or `=` and exited into a `/`, `?`,
 * `#`, `&` or the end. That's what lets {@link readLinkParams} cut the value
 * back out of a written URL with no ambiguity (values are URI-encoded, so they
 * can never contain those delimiters themselves).
 */
function isDelimitedOnce(url: string, token: string): boolean {
  const needle = `{${token}}`;
  const at = url.indexOf(needle);
  if (at <= 0 || url.indexOf(needle, at + 1) !== -1) return false;
  const before = url[at - 1]!;
  if (before !== "/" && before !== "?" && before !== "&" && before !== "=") return false;
  const after = url[at + needle.length];
  return after === undefined || after === "/" || after === "?" || after === "#" || after === "&";
}

/**
 * Parse a manifest's `params` against its URL template. Unlike the sibling
 * validate-and-drop parsers, a bad param can't degrade to a missing param: the
 * template would keep a token nothing can ever fill, so the caller drops the
 * whole entry. Returns the clean list, `undefined` for "none declared", or
 * `null` for "entry is invalid" — also raised when the template carries a
 * non-core token that no param declares.
 */
function parseLinkParams(raw: unknown, url: string): LinkPluginParam[] | undefined | null {
  const out: LinkPluginParam[] = [];
  const seen = new Set<string>();
  if (raw !== undefined) {
    if (!Array.isArray(raw) || raw.length > MAX_PARAMS) return null;
    for (const item of raw) {
      if (!item || typeof item !== "object") return null;
      const o = item as Record<string, unknown>;
      if (!isNonEmptyString(o.token) || !PLACEHOLDER_TOKEN_RE.test(o.token)) return null;
      // Core tokens resolve from the webhook at send — a param may not shadow
      // one, or the user's typed value and the send-time value would fight.
      if (CORE_PLACEHOLDER_TOKENS.has(o.token)) return null;
      if (seen.has(o.token)) return null;
      if (!isDelimitedOnce(url, o.token)) return null;
      if (!isNonEmptyString(o.label)) return null;
      if (o.pattern !== undefined) {
        if (!isNonEmptyString(o.pattern) || o.pattern.length > MAX_PARAM_PATTERN) return null;
        try {
          new RegExp(o.pattern);
        } catch {
          return null;
        }
      }
      seen.add(o.token);
      out.push({
        token: o.token,
        label: o.label.slice(0, MAX_PARAM_LABEL),
        ...(isNonEmptyString(o.hint) ? { hint: o.hint.slice(0, MAX_PARAM_HINT) } : {}),
        ...(isNonEmptyString(o.placeholder)
          ? { placeholder: o.placeholder.slice(0, MAX_PARAM_PLACEHOLDER) }
          : {}),
        ...(isNonEmptyString(o.pattern) ? { pattern: o.pattern } : {}),
      });
    }
  }
  // Every token the template carries must be resolvable — core at send, or a
  // declared param in the editor. Anything else would reach Discord literally.
  for (const m of url.matchAll(TEMPLATE_TOKEN_RE)) {
    const token = m[1]!;
    if (!CORE_PLACEHOLDER_TOKENS.has(token) && !seen.has(token)) return null;
  }
  return out.length ? out : undefined;
}

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
  const params = parseLinkParams(o.params, o.url);
  if (params === null) return null;

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
    ...(isAllowedUrl(o.setupUrl) ? { setupUrl: o.setupUrl } : {}),
    ...(isNonEmptyString(o.setupHint) ? { setupHint: o.setupHint.slice(0, MAX_SETUP_HINT) } : {}),
    ...(params ? { params } : {}),
  };
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

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What one param's value may look like inside a written URL: anything up to
 *  the next delimiter. URI-encoding on write guarantees a real value never
 *  contains these, so the greedy class can't eat past its own segment. */
const PARAM_VALUE_SRC = "([^/?#&]*)";

/**
 * The template as a whole-URL matcher: literals exact, each token a bounded
 * wildcard, declared params capturing. Returns the regex plus the param token
 * captured by each group, in group order.
 */
function templateMatcher(manifest: LinkPluginManifest): { re: RegExp; groups: string[] } {
  const declared = new Set((manifest.params ?? []).map((p) => p.token));
  const groups: string[] = [];
  let src = "^";
  let last = 0;
  for (const m of manifest.url.matchAll(TEMPLATE_TOKEN_RE)) {
    const at = m.index ?? 0;
    src += escapeRegExp(manifest.url.slice(last, at));
    if (declared.has(m[1]!)) {
      groups.push(m[1]!);
      src += PARAM_VALUE_SRC;
    } else {
      // A core token: still raw `{server_id}` in the stored URL (it resolves
      // at send), which the delimiter-bounded class matches like any value.
      src += "(?:[^/?#&]*)";
    }
    last = at + m[0].length;
  }
  src += escapeRegExp(manifest.url.slice(last)) + "$";
  return { re: new RegExp(src), groups };
}

/**
 * The current value of each declared param, read back out of a bound button
 * URL. A still-raw `{token}`, a URL that doesn't fit the template (e.g. an
 * older draft carrying the bare prefix), or an undecodable value all read as
 * `""` — the unfilled state the chip's inputs and the validator key off.
 * `{}` for a manifest without params.
 */
export function readLinkParams(
  manifest: LinkPluginManifest,
  url: string | undefined,
): Record<string, string> {
  const params = manifest.params;
  if (!params?.length) return {};
  const values: Record<string, string> = {};
  for (const p of params) values[p.token] = "";
  if (!url) return values;
  const { re, groups } = templateMatcher(manifest);
  const m = re.exec(url);
  if (!m) return values;
  groups.forEach((token, i) => {
    const raw = m[i + 1] ?? "";
    if (raw === `{${token}}`) return; // the unfilled template form
    try {
      values[token] = decodeURIComponent(raw);
    } catch {
      values[token] = raw;
    }
  });
  return values;
}

/**
 * The button URL for a set of param values: the template with each declared
 * param's URI-encoded value spliced in. The value is written *as given* — an
 * eager trim here would make interior spaces untypeable (the trailing space
 * disappears before the next character lands), so trimming is the input's
 * job, on blur. A whitespace-only value counts as empty and keeps the raw
 * `{token}`, so the unfinished state stays visible in the URL — and flaggable
 * by validation. Core tokens pass through untouched for the send path to
 * resolve. The inverse of {@link readLinkParams}.
 */
export function writeLinkParams(
  manifest: LinkPluginManifest,
  values: Record<string, string>,
): string {
  const declared = new Set((manifest.params ?? []).map((p) => p.token));
  return manifest.url.replace(TEMPLATE_TOKEN_RE, (whole, token: string) => {
    if (!declared.has(token)) return whole;
    const value = values[token] ?? "";
    return value.trim() ? encodeURIComponent(value) : whole;
  });
}

/**
 * True when `value` satisfies the param's `pattern` (or there's nothing to
 * check — no pattern, or no value yet: emptiness is "unfilled", a different
 * state with its own messaging, not "invalid").
 */
export function isValidLinkParamValue(param: LinkPluginParam, value: string): boolean {
  if (!value || !param.pattern) return true;
  try {
    return new RegExp(param.pattern).test(value);
  } catch {
    return true;
  }
}
