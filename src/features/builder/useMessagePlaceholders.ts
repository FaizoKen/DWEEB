/**
 * The placeholders available to insert into the *current* message, grouped by
 * provider — the core server/channel tokens plus any an attached plugin
 * declares. Every text/URL inspector field that supports a `{}` insert reads
 * from this one hook so the menu is identical everywhere and the plugin registry
 * is loaded once on demand.
 *
 * The list is memoised on the message + plugin set, so it only recomputes when a
 * plugin binds/unbinds (which changes the message) or the registry loads — not on
 * every keystroke beyond the unavoidable message-identity change the store makes.
 */

import { useEffect, useMemo } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { usePluginRegistry } from "@/core/state/pluginRegistryStore";
import { isPluginRegistryConfigured } from "@/core/plugins/registry";
import { messagePlaceholders, type PlaceholderGroup } from "@/core/plugins/placeholders";

export function useMessagePlaceholders(): PlaceholderGroup[] {
  const message = useMessageStore((s) => s.message);
  const plugins = usePluginRegistry((s) => s.plugins);
  const loadPlugins = usePluginRegistry((s) => s.load);
  useEffect(() => {
    if (isPluginRegistryConfigured()) loadPlugins();
  }, [loadPlugins]);
  return useMemo(() => messagePlaceholders(message, plugins), [message, plugins]);
}
