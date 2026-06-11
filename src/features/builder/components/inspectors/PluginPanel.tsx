/**
 * Plugin panel — attach an external plugin to an interactive component.
 *
 * Rendered by the Inspector for any plugin-targetable node (interactive button
 * or select). Kept compact: a single "Browse plugins" trigger opens the
 * PluginLibraryModal, which scales with the registry instead of inlining every
 * plugin here. The binding *is* the component's `custom_id`: picking a plugin
 * opens its config iframe, and on save we adopt the `custom_id` it returns.
 * On reload we recompute the attachment purely from that id via `matchPlugin`,
 * so nothing plugin-specific is ever persisted on the message.
 *
 * The whole panel is inert when no registry URL is configured — it renders
 * nothing, leaving the editor exactly as it was before plugins existed.
 */

import { useEffect, useState } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { usePluginRegistry } from "@/core/state/pluginRegistryStore";
import {
  clearPluginSummary,
  getPluginSummary,
  setPluginSummary,
} from "@/core/state/pluginSummaryCache";
import { isPluginRegistryConfigured } from "@/core/plugins/registry";
import type { PluginManifest } from "@/core/plugins/manifest";
import { matchPlugin, pluginsForTarget, targetOf, type PluginTarget } from "@/core/plugins/targets";
import type { AnyComponent, InteractiveButtonComponent } from "@/core/schema/types";
import { Button } from "@/ui/Button";
import { PluginConfigModal } from "@/features/plugins/PluginConfigModal";
import { PluginIcon } from "@/features/plugins/PluginIcon";
import { PluginLibraryModal } from "@/features/plugins/PluginLibraryModal";
import type { PluginSaveResult } from "@/features/plugins/usePluginConfig";
import styles from "./PluginPanel.module.css";

interface Props {
  node: AnyComponent;
}

/** A neutral custom_id to fall back to on detach (won't match any plugin prefix). */
const DETACH_DEFAULTS: Record<PluginTarget, string> = {
  button: "button_action",
  string_select: "string_select",
  user_select: "user_select",
  role_select: "role_select",
  mentionable_select: "mentionable_select",
  channel_select: "channel_select",
};

function currentCustomId(node: AnyComponent): string | undefined {
  return "custom_id" in node ? (node as { custom_id?: string }).custom_id : undefined;
}

export function PluginPanel({ node }: Props) {
  const patch = useMessageStore((s) => s.patchNode);
  const status = usePluginRegistry((s) => s.status);
  const plugins = usePluginRegistry((s) => s.plugins);
  const load = usePluginRegistry((s) => s.load);
  const reload = usePluginRegistry((s) => s.reload);

  // Which plugin's config iframe is open, plus the id we're editing (if any).
  const [configuring, setConfiguring] = useState<{
    manifest: PluginManifest;
    customId?: string;
  } | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);

  // Lazy, idempotent: only the first targetable node to render triggers a fetch.
  useEffect(() => {
    if (isPluginRegistryConfigured()) load();
  }, [load]);

  const target = targetOf(node);
  if (!isPluginRegistryConfigured() || !target) return null;

  const customId = currentCustomId(node);
  const attached = matchPlugin(plugins, customId);
  const available = pluginsForTarget(plugins, target);

  const writeCustomId = (next: string) =>
    patch<InteractiveButtonComponent>(node._id, { custom_id: next });

  const handleSave = (manifest: PluginManifest) => (result: PluginSaveResult) => {
    // Adopting a new id supersedes the old binding's cached summary.
    if (customId && customId !== result.customId) clearPluginSummary(customId);
    writeCustomId(result.customId);
    if (result.summary) setPluginSummary(result.customId, manifest.id, result.summary);
    setConfiguring(null);
  };

  const handleDetach = () => {
    if (customId) clearPluginSummary(customId);
    writeCustomId(DETACH_DEFAULTS[target]);
  };

  return (
    <div className={styles.panel}>
      <div className={styles.heading}>
        <span className={styles.title}>Plugin</span>
        <span className={styles.sub}>Choose what happens when this component is used.</span>
      </div>

      {attached ? (
        <AttachedChip
          manifest={attached}
          customId={customId}
          onReconfigure={() => setConfiguring({ manifest: attached, customId })}
          onDetach={handleDetach}
        />
      ) : status === "loading" ? (
        <p className={styles.muted}>Loading plugins…</p>
      ) : status === "error" ? (
        <p className={styles.muted}>
          Couldn't load plugins.{" "}
          <button type="button" className={styles.link} onClick={reload}>
            Retry
          </button>
        </p>
      ) : available.length === 0 ? (
        <p className={styles.muted}>No plugins available for this component type.</p>
      ) : (
        <button type="button" className={styles.browse} onClick={() => setLibraryOpen(true)}>
          <span>Browse plugins…</span>
          <span className={styles.browseCount}>{available.length}</span>
        </button>
      )}

      {libraryOpen ? (
        <PluginLibraryModal
          plugins={available}
          onPick={(manifest) => {
            setLibraryOpen(false);
            setConfiguring({ manifest });
          }}
          onClose={() => setLibraryOpen(false)}
        />
      ) : null}

      {configuring ? (
        <PluginConfigModal
          key={`${configuring.manifest.id}:${configuring.customId ?? "new"}`}
          manifest={configuring.manifest}
          target={target}
          customId={configuring.customId}
          onSave={handleSave(configuring.manifest)}
          onClose={() => setConfiguring(null)}
        />
      ) : null}
    </div>
  );
}

function AttachedChip({
  manifest,
  customId,
  onReconfigure,
  onDetach,
}: {
  manifest: PluginManifest;
  customId: string | undefined;
  onReconfigure: () => void;
  onDetach: () => void;
}) {
  const cached = getPluginSummary(customId);
  const label = cached?.summary.label ?? manifest.name;
  const detail = cached?.summary.description ?? manifest.description;

  return (
    <div className={styles.chip}>
      <PluginIcon manifest={manifest} summaryIcon={cached?.summary.icon} />
      <div className={styles.chipText}>
        <span className={styles.chipName}>{label}</span>
        {detail ? <span className={styles.chipDesc}>{detail}</span> : null}
        <span className={styles.chipMeta}>via {manifest.name}</span>
      </div>
      <div className={styles.chipActions}>
        <Button size="sm" variant="secondary" onClick={onReconfigure}>
          Reconfigure
        </Button>
        <Button size="sm" variant="ghost" onClick={onDetach}>
          Detach
        </Button>
      </div>
    </div>
  );
}
