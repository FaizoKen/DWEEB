/**
 * Plugin library — browse the plugins available for a component type, and their
 * ready-made presets.
 *
 * Opened from the inspector's compact Plugin panel. Each plugin shows as a group:
 * the plugin's own row (a blank setup) plus, nested under it, one row per preset
 * the plugin declares for this target (the "Staff Application" form, the "Support
 * FAQ" menu…). Picking the plugin hands its manifest back; picking a preset hands
 * the manifest *and* the preset id, which the caller passes to the config UI so it
 * opens pre-filled. The library itself attaches nothing.
 *
 * Built to stay usable as the registry grows: the list lives in a modal with its
 * own search filter (matching plugin and preset names) instead of inlining
 * everything in the inspector.
 */

import { useMemo, useState } from "react";
import { Modal } from "@/ui/Modal";
import { TextInput } from "@/ui/TextInput";
import type { PluginManifest, PluginPreset } from "@/core/plugins/manifest";
import { presetsForTarget, type PluginTarget } from "@/core/plugins/targets";
import { PluginIcon } from "./PluginIcon";
import styles from "./PluginLibraryModal.module.css";

interface Props {
  /** Plugins already filtered to the current component's target type. */
  plugins: PluginManifest[];
  /** The component kind being configured — scopes which presets apply. */
  target: PluginTarget;
  /** Pick a plugin (blank) or a plugin + one of its presets to pre-apply. */
  onPick: (manifest: PluginManifest, presetId?: string) => void;
  onClose: () => void;
}

/** A plugin with the presets that apply to the current target (may be empty). */
interface Group {
  manifest: PluginManifest;
  presets: PluginPreset[];
}

const matches = (q: string, ...fields: (string | undefined)[]) =>
  fields.some((s) => s?.toLowerCase().includes(q));

export function PluginLibraryModal({ plugins, target, onPick, onClose }: Props) {
  const [query, setQuery] = useState("");
  // Which plugin groups have their templates expanded. Collapsed by default so the
  // list reads as one row per plugin; the toggle reveals that plugin's templates.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  // Total preset count, for the search placeholder ("Search N plugins…").
  const presetCount = useMemo(
    () => plugins.reduce((n, p) => n + presetsForTarget(p, target).length, 0),
    [plugins, target],
  );

  // Build a group per plugin, then filter by the query. A query keeps a plugin
  // when it matches the plugin itself (all presets shown) or only some presets
  // (just those shown) — so searching "ticket" surfaces the right rows either way.
  const groups = useMemo<Group[]>(() => {
    const q = query.trim().toLowerCase();
    const out: Group[] = [];
    for (const manifest of plugins) {
      const presets = presetsForTarget(manifest, target);
      if (!q) {
        out.push({ manifest, presets });
        continue;
      }
      const pluginHit = matches(q, manifest.name, manifest.description);
      const presetHits = presets.filter((p) => matches(q, p.name, p.description));
      if (pluginHit) out.push({ manifest, presets });
      else if (presetHits.length) out.push({ manifest, presets: presetHits });
    }
    return out;
  }, [plugins, target, query]);

  const renderGroup = ({ manifest, presets }: Group) => {
    // Templates start collapsed; a live search auto-opens every group so matching
    // rows aren't hidden behind a toggle.
    const open = query.trim() !== "" || expanded.has(manifest.id);
    const listId = `preset-list-${manifest.id}`;

    return (
      <li key={manifest.id} className={styles.group}>
        <div className={styles.header}>
          <button type="button" className={styles.row} onClick={() => onPick(manifest)}>
            <PluginIcon manifest={manifest} />
            <span className={styles.rowText}>
              <span className={styles.rowNameLine}>
                <span className={styles.rowName}>{manifest.name}</span>
                {/* Flags the plugins that drive the shared DWEEB bot — the user has
                    to log in and invite it before the setup works. The rest run over
                    webhooks and carry no tag. */}
                {manifest.requiresBot ? <span className={styles.loginTag}>Needs bot</span> : null}
              </span>
              {manifest.description ? (
                <span className={styles.rowDesc}>{manifest.description}</span>
              ) : null}
            </span>
            {presets.length ? <span className={styles.blankTag}>Start blank</span> : null}
          </button>

          {presets.length ? (
            <button
              type="button"
              className={styles.toggle}
              onClick={() => toggle(manifest.id)}
              aria-expanded={open}
              aria-controls={listId}
              aria-label={`${open ? "Hide" : "Show"} ${presets.length} template${presets.length === 1 ? "" : "s"}`}
            >
              <span className={styles.toggleCount}>{presets.length}</span>
              <svg
                className={open ? styles.chevronOpen : styles.chevron}
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden
              >
                <path
                  d="M6 9l6 6 6-6"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          ) : null}
        </div>

        {presets.length && open ? (
          <ul id={listId} className={styles.presetList}>
            {presets.map((preset) => (
              <li key={preset.id}>
                <button
                  type="button"
                  className={styles.presetRow}
                  onClick={() => onPick(manifest, preset.id)}
                >
                  <span className={styles.presetEmoji} aria-hidden>
                    {preset.emoji ?? "⚡"}
                  </span>
                  <span className={styles.rowText}>
                    <span className={styles.presetName}>{preset.name}</span>
                    {preset.description ? (
                      <span className={styles.presetDesc}>{preset.description}</span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <Modal open title="Plugin library" onClose={onClose}>
      <TextInput
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={
          presetCount > 0
            ? `Search ${plugins.length} plugin${plugins.length === 1 ? "" : "s"} & ${presetCount} templates…`
            : `Search ${plugins.length} plugin${plugins.length === 1 ? "" : "s"}…`
        }
        aria-label="Search plugins"
        autoFocus
      />

      {groups.length === 0 ? (
        <p className={styles.empty}>No plugins match “{query.trim()}”.</p>
      ) : (
        <ul className={styles.list}>{groups.map(renderGroup)}</ul>
      )}

      <p className={styles.note}>
        Pick a plugin to start blank, or a template to open it pre-filled — then customize. Actions
        are handled by external services.
      </p>
    </Modal>
  );
}
