/**
 * Action panel — wire up what happens when an interactive component is used.
 *
 * Rendered by the Inspector for any plugin-targetable node (interactive button
 * or select). It owns the two halves of that one decision, kept together
 * because they're the *same* value: the `custom_id` Discord delivers on use,
 * and the plugin (if any) that claims it by prefix. Picking a plugin opens its
 * config iframe and adopts the `custom_id` it returns; on reload we recompute
 * the attachment purely from that id via `matchPlugin`, so nothing
 * plugin-specific is ever persisted on the message.
 *
 * When no registry ships (`isPluginRegistryConfigured()` is false) the whole
 * plugin half is dormant and we render just the bare `custom_id` field — the
 * editor looks exactly as it did before plugins existed.
 */

import { useEffect, useState, type ReactNode } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { useAuthStore } from "@/core/auth/authStore";
import { useGuildStore } from "@/core/guild/guildStore";
import { usePluginRegistry } from "@/core/state/pluginRegistryStore";
import {
  clearPluginSummary,
  getPluginSummary,
  setPluginSummary,
} from "@/core/state/pluginSummaryCache";
import { isPluginRegistryConfigured } from "@/core/plugins/registry";
import { LIMITS } from "@/core/schema/limits";
import type { PluginManifest } from "@/core/plugins/manifest";
import { matchPlugin, pluginsForTarget, targetOf, type PluginTarget } from "@/core/plugins/targets";
import type {
  AnyComponent,
  InteractiveButtonComponent,
  StringSelectComponent,
} from "@/core/schema/types";
import { cn } from "@/lib/cn";
import { Button } from "@/ui/Button";
import { AlertTriangleIcon, ChevronRightIcon, PuzzleIcon } from "@/ui/Icon";
import { PluginConfigModal } from "@/features/plugins/PluginConfigModal";
import { PluginIcon } from "@/features/plugins/PluginIcon";
import { PluginLibraryModal } from "@/features/plugins/PluginLibraryModal";
import type { PluginSaveResult } from "@/features/plugins/usePluginConfig";
import { CustomIdField } from "./CustomIdField";
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

/** The custom_id field's wording + cap, per kind of component. */
function idFieldProps(target: PluginTarget): { maxLength: number; hint: string } {
  if (target === "button") {
    return {
      maxLength: LIMITS.BUTTON_CUSTOM_ID,
      hint: "Your bot receives this when the button is clicked — set it to wire up the action.",
    };
  }
  return {
    maxLength: LIMITS.SELECT_CUSTOM_ID,
    hint: "Sent to your bot when a user changes the selection — set it to wire up the action.",
  };
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
  if (!target) return null;

  const customId = currentCustomId(node);
  const attached = matchPlugin(plugins, customId);
  const { maxLength, hint } = idFieldProps(target);

  // The raw custom_id field — locked read-only while a plugin owns it (the
  // attachment *is* this value, so editing by hand would break the binding).
  const idField = (
    <CustomIdField
      node={node as AnyComponent & { custom_id: string }}
      maxLength={maxLength}
      hint={hint}
      attachedPlugin={attached}
    />
  );

  // No registry → behave exactly as before plugins existed: just the field.
  if (!isPluginRegistryConfigured()) return idField;

  const available = pluginsForTarget(plugins, target);

  const writeCustomId = (next: string) =>
    patch<InteractiveButtonComponent>(node._id, { custom_id: next });

  const handleSave = (manifest: PluginManifest) => (result: PluginSaveResult) => {
    // Adopting a new id supersedes the old binding's cached summary.
    if (customId && customId !== result.customId) clearPluginSummary(customId);
    // The plugin owns the custom_id, and — for a string select — may also hand
    // back the exact option list to wire, so the user never maps each option's
    // value (e.g. a role id) by hand. Both get locked in their inspectors while
    // the plugin stays attached.
    const fields: Partial<StringSelectComponent> = { custom_id: result.customId };
    if (target === "string_select" && result.options?.length) fields.options = result.options;
    patch<StringSelectComponent>(node._id, fields);
    // Cache the summary plus, for a guild-scoped plugin, the guild it targets —
    // the Send panel uses the latter to warn before posting to another server.
    if (result.summary)
      setPluginSummary(result.customId, manifest.id, result.summary, result.guildId);
    setConfiguring(null);
  };

  const handleDetach = () => {
    if (customId) clearPluginSummary(customId);
    writeCustomId(DETACH_DEFAULTS[target]);
  };

  // The plugin chooser — the prominent, recommended path. Falls back to a
  // status line while the registry loads / errors / has nothing to offer.
  let chooser: ReactNode;
  let offersPlugin = false;
  if (attached) {
    chooser = (
      <AttachedChip
        manifest={attached}
        customId={customId}
        onReconfigure={() => setConfiguring({ manifest: attached, customId })}
        onDetach={handleDetach}
      />
    );
  } else if (status === "loading") {
    chooser = <p className={styles.muted}>Loading plugins…</p>;
  } else if (status === "error") {
    chooser = (
      <p className={styles.muted}>
        Couldn't load plugins.{" "}
        <button type="button" className={styles.link} onClick={reload}>
          Retry
        </button>
      </p>
    );
  } else if (available.length === 0) {
    chooser = <p className={styles.muted}>No plugins available for this component type.</p>;
  } else {
    offersPlugin = true;
    chooser = (
      <button type="button" className={styles.browse} onClick={() => setLibraryOpen(true)}>
        <span className={styles.browseIcon} aria-hidden>
          <PuzzleIcon size={18} />
        </span>
        <span className={styles.browseBody}>
          <span className={styles.browseTitle}>Browse plugins</span>
          <span className={styles.browseSub}>Let a ready-made action handle this for you</span>
        </span>
        <span className={styles.browseCount}>{available.length}</span>
        <ChevronRightIcon size={16} className={styles.browseChevron} aria-hidden />
      </button>
    );
  }

  return (
    <div className={styles.panel}>
      <div className={styles.heading}>
        <span className={styles.title}>Action</span>
        <span className={styles.sub}>
          {target === "button"
            ? "What happens when someone clicks this button."
            : "What happens when someone uses this menu."}
        </span>
      </div>

      {chooser}

      {/* The plugin and the custom_id are the same decision: a plugin claims
          the id, or you set one yourself. Spell that "either/or" out so the
          field below reads as part of this section, not a stray input. */}
      {offersPlugin ? (
        <div className={styles.orRow}>
          <span className={styles.orText}>or set the id manually</span>
        </div>
      ) : null}

      {idField}

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

  // A guild-scoped binding (Self Role et al.) carries the server it was set up
  // for. Surface that here so a wrong-server binding is caught while editing —
  // not only at the Send page, where the destination is finally chosen and the
  // hard block lives. The guild is only cached for guild-scoped plugins, so for
  // every other binding this line simply doesn't render.
  const targetGuildId = cached?.guildId;
  const authGuilds = useAuthStore((s) => s.guilds);
  // Signed out: with no session we can't resolve the id to a server name (the
  // line falls back to the raw id) and there's no connected guild to compare
  // against, so the mismatch caution below can never fire. Flag it as its own
  // caution that prompts sign-in, so a wrong-server binding still gets a second
  // look here rather than slipping through to the Send page unchecked.
  const signedOut = useAuthStore((s) => s.status) === "anon";
  // The connected guild is the closest thing the editor has to a "current
  // server": when one is connected and it differs from the binding's target,
  // the line escalates from a neutral fact to a caution. With nothing connected
  // there's no destination to judge against, so we never cry wolf — the real
  // block still happens at send time against the chosen webhook's guild.
  const connectedGuildId = useGuildStore((s) => s.guildId);

  const targetName =
    (targetGuildId && authGuilds.find((g) => g.id === targetGuildId)?.name) || targetGuildId;
  const mismatch = !!targetGuildId && connectedGuildId !== "" && connectedGuildId !== targetGuildId;
  const connectedName =
    authGuilds.find((g) => g.id === connectedGuildId)?.name ?? "a different server";
  const warn = mismatch || signedOut;

  return (
    <div className={styles.chip}>
      <PluginIcon manifest={manifest} summaryIcon={cached?.summary.icon} />
      <div className={styles.chipText}>
        <span className={styles.chipName}>{label}</span>
        {detail ? <span className={styles.chipDesc}>{detail}</span> : null}
        {targetGuildId ? (
          <span
            className={cn(styles.chipTarget, warn && styles.chipTargetWarn)}
            title={targetGuildId}
          >
            {warn ? (
              <AlertTriangleIcon size={12} className={styles.chipTargetIcon} aria-hidden />
            ) : null}
            {mismatch
              ? `Targets ${targetName} — you're connected to ${connectedName}`
              : signedOut
                ? `Targets ${targetName} — sign in to verify the server`
                : `Targets ${targetName}`}
          </span>
        ) : null}
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
