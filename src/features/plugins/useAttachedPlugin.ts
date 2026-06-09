/**
 * Resolve the plugin currently attached to a component, by `custom_id` prefix.
 *
 * Returns the owning {@link PluginManifest} or `null`. Like `PluginPanel`, it
 * lazily kicks off the registry load on mount, so an inspector that only wants
 * to *display* the attachment (e.g. to soften a capability note) doesn't have
 * to depend on the panel. Always `null` when the registry is unconfigured, so
 * callers behave exactly as before plugins existed.
 */

import { useEffect } from "react";
import { usePluginRegistry } from "@/core/state/pluginRegistryStore";
import { isPluginRegistryConfigured } from "@/core/plugins/registry";
import { isPluginTarget, matchPlugin } from "@/core/plugins/targets";
import type { PluginManifest } from "@/core/plugins/manifest";
import type { AnyComponent } from "@/core/schema/types";

export function useAttachedPlugin(node: AnyComponent): PluginManifest | null {
  const plugins = usePluginRegistry((s) => s.plugins);
  const load = usePluginRegistry((s) => s.load);

  useEffect(() => {
    if (isPluginRegistryConfigured()) load();
  }, [load]);

  if (!isPluginRegistryConfigured() || !isPluginTarget(node)) return null;
  const customId = "custom_id" in node ? (node as { custom_id?: string }).custom_id : undefined;
  return matchPlugin(plugins, customId);
}
