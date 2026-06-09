/**
 * Plugin registry store.
 *
 * Holds the plugin manifests for the picker. The registry is bundled into the
 * build (see `core/plugins/registry.ts`), so there's nothing to fetch: the
 * store is `ready` from the start with the parsed list. `load()`/`reload()` are
 * kept as no-ops so callers (`PluginPanel`, `useAttachedPlugin`) don't need to
 * know the source changed. When the bundled registry is empty the list is
 * empty, so builds that ship no plugins carry zero behavior.
 */

import { create } from "zustand";
import { getPlugins } from "@/core/plugins/registry";
import type { PluginManifest } from "@/core/plugins/manifest";

type RegistryStatus = "idle" | "loading" | "ready" | "error";

interface PluginRegistryState {
  status: RegistryStatus;
  plugins: PluginManifest[];
  error: string | null;
  /** No-op: the bundled registry is ready synchronously. Kept for call sites. */
  load(): void;
  /** No-op: there's nothing to re-fetch. Kept for call sites. */
  reload(): void;
}

export const usePluginRegistry = create<PluginRegistryState>(() => ({
  status: "ready",
  plugins: getPlugins(),
  error: null,
  load() {},
  reload() {},
}));
