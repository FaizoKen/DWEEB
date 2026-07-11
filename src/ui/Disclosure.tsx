/**
 * Subtle click-to-expand for power-user fields.
 *
 * The technical fields the editor used to hide behind a global Advanced
 * switch (raw snowflakes, custom ids, overrides) now sit inline behind this
 * low-key text disclosure: always reachable, never in the way. Built on a
 * native <details>/<summary> so keyboard and screen-reader support come for
 * free; state is per-instance and starts collapsed on every mount.
 */

import { useEffect, useRef, type ReactNode } from "react";
import styles from "./Disclosure.module.css";

interface DisclosureProps {
  /** Summary text. Defaults to the common case. */
  label?: string;
  /** Start expanded on mount — used when a field inside carries a validation
   *  issue, so the problem isn't hidden behind the fold. Mount-time only (set
   *  via the DOM, not a controlled prop), so the user can still collapse it. */
  defaultOpen?: boolean;
  children: ReactNode;
}

export function Disclosure({ label = "Advanced", defaultOpen = false, children }: DisclosureProps) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (defaultOpen && ref.current) ref.current.open = true;
    // Mount-time default only — re-renders must not fight a manual collapse.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <details ref={ref} className={styles.disclosure}>
      <summary className={styles.summary}>{label}</summary>
      <div className={styles.body}>{children}</div>
    </details>
  );
}
