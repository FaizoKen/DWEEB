/**
 * Plugin library — browse the plugins available for a component type.
 *
 * Opened from the inspector's compact Plugin panel. Picking a plugin hands its
 * manifest back to the caller (which then opens the config modal); the library
 * itself attaches nothing. Built to stay usable as the registry grows: the
 * list lives in a modal with its own search filter instead of inlining every
 * plugin in the inspector.
 */

import { useMemo, useState } from "react";
import { Modal } from "@/ui/Modal";
import { TextInput } from "@/ui/TextInput";
import type { PluginManifest } from "@/core/plugins/manifest";
import { PluginIcon } from "./PluginIcon";
import styles from "./PluginLibraryModal.module.css";

interface Props {
  /** Plugins already filtered to the current component's target type. */
  plugins: PluginManifest[];
  onPick: (manifest: PluginManifest) => void;
  onClose: () => void;
}

export function PluginLibraryModal({ plugins, onPick, onClose }: Props) {
  const [query, setQuery] = useState("");

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return plugins;
    return plugins.filter((p) => [p.name, p.description].some((s) => s?.toLowerCase().includes(q)));
  }, [plugins, query]);

  return (
    <Modal open title="Plugin library" onClose={onClose}>
      <TextInput
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={`Search ${plugins.length} plugin${plugins.length === 1 ? "" : "s"}…`}
        aria-label="Search plugins"
        autoFocus
      />

      {shown.length === 0 ? (
        <p className={styles.empty}>No plugins match “{query.trim()}”.</p>
      ) : (
        <ul className={styles.list}>
          {shown.map((p) => (
            <li key={p.id}>
              <button type="button" className={styles.row} onClick={() => onPick(p)}>
                <PluginIcon manifest={p} />
                <span className={styles.rowText}>
                  <span className={styles.rowName}>{p.name}</span>
                  {p.description ? <span className={styles.rowDesc}>{p.description}</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className={styles.note}>
        Actions are handled by external services — picking a plugin opens its setup.
      </p>
    </Modal>
  );
}
