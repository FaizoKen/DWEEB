/**
 * Plugin registry — bundled at build time.
 *
 * The set of available plugins lives in `registry.json` next to this file and
 * is compiled into the bundle. Adding or removing a plugin means editing that
 * file and rebuilding the web app — there is no live registry service and no
 * network fetch. An empty `plugins` array leaves the whole feature dormant
 * (`isPluginRegistryConfigured()` is false, the PluginPanel renders nothing),
 * exactly mirroring the proxy gating in `guild/config.ts`.
 *
 * Parsing is defensive — same contract as `serialization/normalize.ts`: a
 * malformed or duplicate manifest is dropped rather than trusted (see
 * `manifest.ts`), so a typo in `registry.json` degrades to a missing entry,
 * never a runtime throw.
 */

import registryData from "./registry.json";
import { parseRegistryPayload, type PluginManifest } from "./manifest";

/** The bundled plugins, validated once at module load. */
export const PLUGINS: PluginManifest[] = parseRegistryPayload(registryData);

/** True when at least one valid plugin ships in the bundle — the feature is usable. */
export function isPluginRegistryConfigured(): boolean {
  return PLUGINS.length > 0;
}

/** The bundled, validated plugin manifests. Synchronous; never throws. */
export function getPlugins(): PluginManifest[] {
  return PLUGINS;
}
