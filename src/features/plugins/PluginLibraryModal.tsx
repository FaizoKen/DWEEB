/**
 * Plugin library — browse the actions a component can take, and their
 * ready-made presets.
 *
 * Opened from the inspector's Action panel. It has two shapes, driven by whether
 * `linkPlugins` are passed:
 *
 *  - **Selects** (no link plugins): a flat list, one group per interactive
 *    plugin. Each plugin's own row (a blank setup) plus, nested under it, one row
 *    per preset it declares for this target (the "Staff Application" form, the
 *    "Support FAQ" menu…).
 *  - **Buttons** (link plugins passed): the *combined* library. The interactive
 *    plugins and the URL-based link plugins are the two ways a button can act —
 *    handled-by-DWEEB vs. opens-an-external-page — so they're shown as two
 *    labelled categories in one modal. Picking a link plugin hands its manifest
 *    back; the caller switches the button to a Link and adopts the URL.
 *
 * Picking an interactive plugin hands its manifest back; picking a preset hands
 * the manifest *and* the preset id, which the caller passes to the config UI so
 * it opens pre-filled. The library itself attaches nothing.
 *
 * Built to stay usable as the registry grows: the list lives in a modal with its
 * own search filter (matching plugin and preset names) instead of inlining
 * everything in the inspector.
 */

import { useMemo, useState } from "react";
import { Modal } from "@/ui/Modal";
import { TextInput } from "@/ui/TextInput";
import { GlobeIcon, PuzzleIcon } from "@/ui/Icon";
import type { PluginManifest, PluginPreset } from "@/core/plugins/manifest";
import type { LinkPluginManifest } from "@/core/plugins/linkManifest";
import { presetsForTarget, type PluginTarget } from "@/core/plugins/targets";
import { PluginIcon } from "./PluginIcon";
import styles from "./PluginLibraryModal.module.css";

interface Props {
  /** Plugins already filtered to the current component's target type. */
  plugins: PluginManifest[];
  /** The component kind being configured — scopes which presets apply. */
  target: PluginTarget;
  /**
   * URL-based link plugins offered alongside the interactive ones — only for a
   * button, which can act via a Link too. Present ⇒ the modal renders the
   * combined, two-category layout; absent/empty ⇒ the flat interactive list.
   */
  linkPlugins?: LinkPluginManifest[];
  /** Pick a plugin (blank) or a plugin + one of its presets to pre-apply. */
  onPick: (manifest: PluginManifest, presetId?: string) => void;
  /** Pick a link plugin — the caller switches the button to a Link and adopts
   *  its URL. Only invoked from the combined layout, so it's optional. */
  onPickLink?: (manifest: LinkPluginManifest) => void;
  onClose: () => void;
}

/** A plugin with the presets that apply to the current target (may be empty). */
interface Group {
  manifest: PluginManifest;
  presets: PluginPreset[];
}

const matches = (q: string, ...fields: (string | undefined)[]) =>
  fields.some((s) => s?.toLowerCase().includes(q));

export function PluginLibraryModal({
  plugins,
  target,
  linkPlugins = [],
  onPick,
  onPickLink,
  onClose,
}: Props) {
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

  // The link category only exists for buttons — a select never receives it.
  const combined = linkPlugins.length > 0;

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

  const linkMatches = useMemo<LinkPluginManifest[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return linkPlugins;
    return linkPlugins.filter((p) => matches(q, p.name, p.description, p.publisher));
  }, [linkPlugins, query]);

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

  const renderLinkRow = (manifest: LinkPluginManifest) => (
    <li key={manifest.id} className={styles.group}>
      <div className={styles.header}>
        <button type="button" className={styles.row} onClick={() => onPickLink?.(manifest)}>
          <PluginIcon manifest={manifest} />
          <span className={styles.rowText}>
            <span className={styles.rowNameLine}>
              <span className={styles.rowName}>{manifest.name}</span>
              <span className={styles.externalTag}>External</span>
              {/* Flags services a server manager must register with (once, on the
                  service's own dashboard) before the link works. */}
              {manifest.setupUrl ? <span className={styles.loginTag}>Needs setup</span> : null}
            </span>
            {manifest.description ? (
              <span className={styles.rowDesc}>{manifest.description}</span>
            ) : null}
          </span>
        </button>
      </div>
    </li>
  );

  const noMatches = groups.length === 0 && linkMatches.length === 0;

  return (
    <Modal open title={combined ? "Add an action" : "Plugin library"} onClose={onClose}>
      <TextInput
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholderFor(plugins.length, linkPlugins.length, presetCount)}
        aria-label="Search actions"
        autoFocus
      />

      {noMatches ? (
        <p className={styles.empty}>No actions match “{query.trim()}”.</p>
      ) : combined ? (
        <>
          {groups.length ? (
            <section className={styles.category}>
              <header className={styles.categoryHead}>
                <span className={styles.categoryIcon} aria-hidden>
                  <PuzzleIcon size={16} />
                </span>
                <span className={styles.categoryText}>
                  <span className={styles.categoryTitleLine}>
                    <span className={styles.categoryTitle}>Interactive</span>
                    <span className={styles.categoryCount}>{groups.length}</span>
                  </span>
                  <span className={styles.categorySub}>Handled by DWEEB — no bot code needed.</span>
                </span>
              </header>
              <ul className={styles.list}>{groups.map(renderGroup)}</ul>
            </section>
          ) : null}

          {linkMatches.length ? (
            <section className={styles.category}>
              <header className={styles.categoryHead}>
                <span
                  className={`${styles.categoryIcon} ${styles.categoryIconExternal}`}
                  aria-hidden
                >
                  <GlobeIcon size={16} />
                </span>
                <span className={styles.categoryText}>
                  <span className={styles.categoryTitleLine}>
                    <span className={styles.categoryTitle}>Link to a service</span>
                    <span className={styles.categoryCount}>{linkMatches.length}</span>
                  </span>
                  <span className={styles.categorySub}>
                    Opens an external page — works on any webhook, never expires.
                  </span>
                </span>
              </header>
              <ul className={styles.list}>{linkMatches.map(renderLinkRow)}</ul>
            </section>
          ) : null}
        </>
      ) : (
        <ul className={styles.list}>{groups.map(renderGroup)}</ul>
      )}

      <p className={styles.note}>
        {combined
          ? "Pick an action to attach it. Interactive actions run through the DWEEB app; link actions open an external service. Either way, DWEEB names the button for you — tweak it after."
          : "Pick a plugin to start blank, or a template to open it pre-filled — then customize. Actions are handled by external services."}
      </p>
    </Modal>
  );
}

/** The search box's placeholder, counting whatever the modal is showing. */
function placeholderFor(pluginCount: number, linkCount: number, presetCount: number): string {
  const total = pluginCount + linkCount;
  const plural = total === 1 ? "" : "s";
  if (linkCount > 0) return `Search ${total} action${plural}…`;
  if (presetCount > 0) {
    return `Search ${pluginCount} plugin${pluginCount === 1 ? "" : "s"} & ${presetCount} templates…`;
  }
  return `Search ${pluginCount} plugin${pluginCount === 1 ? "" : "s"}…`;
}
