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

/**
 * Dev-only config-UI origins. `registry.json` points each plugin at its
 * deployed hostname (e.g. `https://modalform.dweeb.faizo.net`) for production.
 * When the web app runs under `vite` (DEV), the config iframe — and the
 * relative `/api/instances` calls it makes — should instead hit the plugin
 * microservice you run locally (`cargo run` in `plugins/<id>`; default ports
 * below, mirroring each plugin's `.env.example` and the dispatcher's `ROUTES`).
 * Point a plugin elsewhere with its `VITE_DEV_*_ORIGIN` env var; a plugin id
 * absent here keeps its `registry.json` URL. A localhost iframe is fine in dev
 * because the CSP that locks down `frame-src` is only injected on the
 * production build (see `vite.config.ts`).
 */
const DEV_CONFIG_ORIGINS: Record<string, string> = {
  "modal-form": (import.meta.env.VITE_DEV_MODAL_FORM_ORIGIN || "http://localhost:8090").trim(),
  "ping-pong": (import.meta.env.VITE_DEV_PING_PONG_ORIGIN || "http://localhost:8091").trim(),
  "self-role": (import.meta.env.VITE_DEV_SELF_ROLE_ORIGIN || "http://localhost:8092").trim(),
  "tickets": (import.meta.env.VITE_DEV_TICKETS_ORIGIN || "http://localhost:8093").trim(),
  "giveaway": (import.meta.env.VITE_DEV_GIVEAWAY_ORIGIN || "http://localhost:8094").trim(),
};

/** Repoint a plugin's configUrl at its local dev origin, preserving the path. */
function withDevOrigin(plugin: PluginManifest): PluginManifest {
  const origin = DEV_CONFIG_ORIGINS[plugin.id];
  if (!origin) return plugin;
  try {
    const current = new URL(plugin.configUrl);
    const local = new URL(`${current.pathname}${current.search}`, origin);
    return { ...plugin, configUrl: local.toString() };
  } catch {
    return plugin;
  }
}

const parsed = parseRegistryPayload(registryData);

/** The bundled plugins, validated once at module load (dev: pointed at localhost). */
export const PLUGINS: PluginManifest[] = import.meta.env.DEV ? parsed.map(withDevOrigin) : parsed;

/** True when at least one valid plugin ships in the bundle — the feature is usable. */
export function isPluginRegistryConfigured(): boolean {
  return PLUGINS.length > 0;
}

/** The bundled, validated plugin manifests. Synchronous; never throws. */
export function getPlugins(): PluginManifest[] {
  return PLUGINS;
}
