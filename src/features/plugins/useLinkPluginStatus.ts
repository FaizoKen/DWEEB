/**
 * Live setup status for an attached link plugin.
 *
 * Resolves the manifest's `statusUrl` probe against the editor's *connected*
 * guild (the same "current server" the interactive chip judges guild-scoped
 * bindings against). `"unknown"` — no probe declared, no server connected, or
 * the probe failed — renders exactly as the pre-probe chip did, so the hook
 * can be used unconditionally.
 */

import { useEffect, useState } from "react";
import { useGuildStore } from "@/core/guild/guildStore";
import { fetchLinkPluginStatus, type LinkPluginStatus } from "@/core/plugins/linkStatus";
import type { LinkPluginManifest } from "@/core/plugins/linkManifest";

export function useLinkPluginStatus(manifest: LinkPluginManifest): LinkPluginStatus {
  const guildId = useGuildStore((s) => s.guildId);
  const [status, setStatus] = useState<LinkPluginStatus>("unknown");

  useEffect(() => {
    if (!manifest.statusUrl || !guildId) {
      setStatus("unknown");
      return;
    }
    let cancelled = false;
    void fetchLinkPluginStatus(manifest, guildId).then((resolved) => {
      if (!cancelled) setStatus(resolved);
    });
    return () => {
      cancelled = true;
    };
  }, [manifest, guildId]);

  return status;
}
