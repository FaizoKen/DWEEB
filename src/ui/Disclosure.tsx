/**
 * Subtle click-to-expand for power-user fields.
 *
 * The technical fields the editor used to hide behind a global Advanced
 * switch (raw snowflakes, custom ids, overrides) now sit inline behind this
 * low-key text disclosure: always reachable, never in the way. Built on a
 * native <details>/<summary> so keyboard and screen-reader support come for
 * free; state is per-instance and starts collapsed on every mount.
 */

import type { ReactNode } from "react";
import styles from "./Disclosure.module.css";

interface DisclosureProps {
  /** Summary text. Defaults to the common case. */
  label?: string;
  children: ReactNode;
}

export function Disclosure({ label = "Advanced", children }: DisclosureProps) {
  return (
    <details className={styles.disclosure}>
      <summary className={styles.summary}>{label}</summary>
      <div className={styles.body}>{children}</div>
    </details>
  );
}
