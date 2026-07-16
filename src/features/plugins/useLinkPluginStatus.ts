/**
 * Live setup status for an attached link plugin.
 *
 * Resolves the manifest's `statusUrl` probe against the editor's *connected*
 * guild (the same "current server" the interactive chip judges guild-scoped
 * bindings against). `"unknown"` — no probe declared, no server connected, or
 * the probe failed — renders exactly as the pre-probe chip did, so the hook
 * can be used unconditionally.
 *
 * The status re-probes (cache-bypassing) when the window regains focus: the
 * expected loop is "chip says Needs setup → admin opens the service's
 * dashboard in a new tab → sets it up → comes back", and the flip should be
 * visible on return, not up to a TTL later. Throttled so rapid focus flips
 * can't spam the service.
 */

import { useEffect, useState } from "react";
import { useGuildStore } from "@/core/guild/guildStore";
import { fetchLinkPluginStatus, type LinkPluginStatusResult } from "@/core/plugins/linkStatus";
import type { LinkPluginManifest } from "@/core/plugins/linkManifest";

const UNKNOWN: LinkPluginStatusResult = { status: "unknown" };

/** Minimum spacing between focus-triggered fresh probes. */
const FOCUS_REPROBE_MIN_MS = 5_000;

export function useLinkPluginStatus(manifest: LinkPluginManifest): LinkPluginStatusResult {
  const guildId = useGuildStore((s) => s.guildId);
  const [result, setResult] = useState<LinkPluginStatusResult>(UNKNOWN);

  useEffect(() => {
    if (!manifest.statusUrl || !guildId) {
      setResult(UNKNOWN);
      return;
    }
    let cancelled = false;
    const apply = (resolved: LinkPluginStatusResult) => {
      if (!cancelled) setResult(resolved);
    };

    void fetchLinkPluginStatus(manifest, guildId).then(apply);

    let lastFocusProbe = 0;
    const onFocus = () => {
      const now = Date.now();
      if (now - lastFocusProbe < FOCUS_REPROBE_MIN_MS) return;
      lastFocusProbe = now;
      void fetchLinkPluginStatus(manifest, guildId, { fresh: true }).then(apply);
    };
    window.addEventListener("focus", onFocus);

    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, [manifest, guildId]);

  return result;
}
