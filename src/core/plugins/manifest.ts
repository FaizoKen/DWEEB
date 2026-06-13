/**
 * Plugin manifest — the contract a plugin microservice publishes.
 *
 * A plugin is an external microservice that gives an interactive component
 * (a button with a `custom_id`, or a select menu) its behavior. DWEEB never
 * runs plugin code: it reads a plugin's manifest from a remote registry (see
 * `registry.ts`), shows the plugin's own configuration UI inside a sandboxed
 * iframe (see `protocol.ts`), and writes back the single thing the plugin owns
 * on the message — the component's `custom_id`.
 *
 * The manifest is intentionally small and stable so new plugins can be added by
 * registering them remotely, without touching this codebase. Anything DWEEB
 * doesn't recognize is dropped on parse rather than trusted; a malformed
 * manifest simply doesn't appear in the picker.
 *
 * See `docs/plugins.md` for the authoring guide.
 */

import type { PluginTarget } from "./targets";
import { ALL_PLUGIN_TARGETS } from "./targets";

/** Manifest schema version. Bump when the shape below changes incompatibly. */
export const PLUGIN_MANIFEST_SCHEMA_VERSION = 1 as const;

/** postMessage protocol version DWEEB speaks (see `protocol.ts`). */
export const PLUGIN_API_VERSION = 1 as const;

export interface PluginManifest {
  /** Manifest shape version. Only {@link PLUGIN_MANIFEST_SCHEMA_VERSION} is accepted. */
  schemaVersion: typeof PLUGIN_MANIFEST_SCHEMA_VERSION;
  /** Stable kebab-case id, unique within a registry. Routes nothing by itself. */
  id: string;
  /** Human name shown in the picker and the attached-plugin chip. */
  name: string;
  /** One-line description shown under the name in the picker. */
  description: string;
  /** Plugin's own semver — informational; surfaced for support/debugging. */
  version: string;
  /** Optional https icon URL shown in the picker and chip. */
  icon?: string;
  /** Optional https homepage / docs link. */
  homepage?: string;
  /** Optional publisher/author label. */
  publisher?: string;
  /** Which interactive component kinds this plugin can attach to. */
  targets: PluginTarget[];
  /** https URL of the configuration iframe DWEEB embeds. */
  configUrl: string;
  /**
   * Prefix every `custom_id` this plugin mints starts with. It's how DWEEB
   * re-identifies, on reload of a draft or share link, which plugin owns a
   * given component — and how it validates the `custom_id` a plugin sends back.
   * Keep it short and unique (e.g. `"poll:"`); the rest of the id is the
   * plugin's own opaque instance reference.
   */
  customIdPrefix: string;
  /**
   * Highest postMessage protocol version the plugin understands. Optional;
   * defaults to 1. DWEEB sends its own {@link PLUGIN_API_VERSION} in `init`.
   */
  apiVersion?: number;
  /**
   * For a `string_select` plugin: declares that the plugin owns the menu's
   * option list. When set, the plugin's `save` may hand back the `options` to
   * wire onto the select, and DWEEB **locks** the options editor — each value
   * is part of the plugin's contract (e.g. a role id), so hand-editing would
   * silently break it, exactly as the plugin-owned `custom_id` is locked.
   * Defaults to false: a select plugin that leaves options to the user.
   */
  managesSelectOptions?: boolean;
}

/** Shape the registry endpoint returns. */
export interface PluginRegistryPayload {
  schemaVersion: typeof PLUGIN_MANIFEST_SCHEMA_VERSION;
  plugins: PluginManifest[];
}

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Only https (or, for local dev convenience, http://localhost) iframe/registry URLs are trusted. */
function isAllowedUrl(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length === 0) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  // Allow http only against loopback so a plugin can be developed locally.
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

/**
 * Validate-and-drop parse of one manifest entry. Returns a clean
 * {@link PluginManifest} or `null` when a required field is missing or
 * malformed. Never throws — mirrors the defensive style of
 * `serialization/normalize.ts`.
 */
export function parseManifest(raw: unknown): PluginManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  if (o.schemaVersion !== PLUGIN_MANIFEST_SCHEMA_VERSION) return null;
  if (!isNonEmptyString(o.id) || !isNonEmptyString(o.name)) return null;
  if (!isAllowedUrl(o.configUrl)) return null;
  if (!isNonEmptyString(o.customIdPrefix)) return null;

  const targets = Array.isArray(o.targets)
    ? (o.targets.filter((t): t is PluginTarget =>
        ALL_PLUGIN_TARGETS.includes(t as PluginTarget),
      ) as PluginTarget[])
    : [];
  if (targets.length === 0) return null;

  const manifest: PluginManifest = {
    schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
    id: o.id,
    name: o.name,
    description: isNonEmptyString(o.description) ? o.description : "",
    version: isNonEmptyString(o.version) ? o.version : "0.0.0",
    targets,
    configUrl: o.configUrl,
    customIdPrefix: o.customIdPrefix,
    ...(isAllowedUrl(o.icon) ? { icon: o.icon } : {}),
    ...(isAllowedUrl(o.homepage) ? { homepage: o.homepage } : {}),
    ...(isNonEmptyString(o.publisher) ? { publisher: o.publisher } : {}),
    ...(typeof o.apiVersion === "number" ? { apiVersion: o.apiVersion } : {}),
    ...(o.managesSelectOptions === true ? { managesSelectOptions: true } : {}),
  };
  return manifest;
}

/** Parse a full registry payload into the valid manifests it contains. */
export function parseRegistryPayload(raw: unknown): PluginManifest[] {
  if (!raw || typeof raw !== "object") return [];
  const o = raw as Record<string, unknown>;
  if (o.schemaVersion !== PLUGIN_MANIFEST_SCHEMA_VERSION) return [];
  if (!Array.isArray(o.plugins)) return [];

  const seen = new Set<string>();
  const out: PluginManifest[] = [];
  for (const entry of o.plugins) {
    const manifest = parseManifest(entry);
    if (!manifest) continue;
    // First registration wins on a duplicate id — keeps the picker deterministic.
    if (seen.has(manifest.id)) continue;
    seen.add(manifest.id);
    out.push(manifest);
  }
  return out;
}

/** The iframe's origin — what we accept postMessage from for this plugin. */
export function pluginOrigin(manifest: PluginManifest): string {
  return new URL(manifest.configUrl).origin;
}
