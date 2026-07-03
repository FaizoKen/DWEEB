/**
 * Link-plugin library — browse the URL-based plugins a Link button can point at.
 *
 * The link sibling of {@link PluginLibraryModal}, sharing its stylesheet so the
 * two libraries read as one surface. It's structurally simpler: a link plugin
 * has no presets and no config iframe, so picking a row is the whole flow — the
 * caller writes the manifest's URL template onto the button and the chip
 * appears. The "Needs setup" tag marks services that must be registered for the
 * server (once, on the service's own dashboard) before the link does anything.
 */

import { useMemo, useState } from "react";
import { Modal } from "@/ui/Modal";
import { TextInput } from "@/ui/TextInput";
import type { LinkPluginManifest } from "@/core/plugins/linkManifest";
import { PluginIcon } from "./PluginIcon";
import styles from "./PluginLibraryModal.module.css";

interface Props {
  plugins: LinkPluginManifest[];
  /** Pick a plugin — the caller adopts its URL template immediately. */
  onPick: (manifest: LinkPluginManifest) => void;
  onClose: () => void;
}

const matches = (q: string, ...fields: (string | undefined)[]) =>
  fields.some((s) => s?.toLowerCase().includes(q));

export function LinkPluginLibraryModal({ plugins, onPick, onClose }: Props) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return plugins;
    return plugins.filter((p) => matches(q, p.name, p.description, p.publisher));
  }, [plugins, query]);

  return (
    <Modal open title="Link plugin library" onClose={onClose}>
      <TextInput
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={`Search ${plugins.length} link plugin${plugins.length === 1 ? "" : "s"}…`}
        aria-label="Search link plugins"
        autoFocus
      />

      {filtered.length === 0 ? (
        <p className={styles.empty}>No link plugins match “{query.trim()}”.</p>
      ) : (
        <ul className={styles.list}>
          {filtered.map((manifest) => (
            <li key={manifest.id} className={styles.group}>
              <div className={styles.header}>
                <button type="button" className={styles.row} onClick={() => onPick(manifest)}>
                  <PluginIcon manifest={manifest} />
                  <span className={styles.rowText}>
                    <span className={styles.rowNameLine}>
                      <span className={styles.rowName}>{manifest.name}</span>
                      {/* Flags services a server manager must register with (once,
                          on the service's own dashboard) before the link works. */}
                      {manifest.setupUrl ? (
                        <span className={styles.loginTag}>Needs setup</span>
                      ) : null}
                    </span>
                    {manifest.description ? (
                      <span className={styles.rowDesc}>{manifest.description}</span>
                    ) : null}
                  </span>
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className={styles.note}>
        A link plugin points this button at an external service's page — it works through any
        webhook, needs no bot from DWEEB, and never expires. The service handles everything after
        the click.
      </p>
    </Modal>
  );
}
