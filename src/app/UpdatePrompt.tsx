/**
 * Discord-style "Update" affordance.
 *
 * When a new build is waiting (see `updateStore`), a highlighted pill drops into
 * the top-right corner — the uncluttered preview side on desktop — instead of a
 * fleeting toast, so the prompt stays put until the user acts. Clicking it
 * activates the waiting service worker and reloads onto the new build; while
 * that's in flight the button shows progress and disables to avoid a double
 * trigger.
 */

import { useUpdateStore } from "@/core/state/updateStore";
import { RefreshIcon } from "@/ui/Icon";
import styles from "./UpdatePrompt.module.css";

export function UpdatePrompt() {
  const available = useUpdateStore((s) => s.available);
  const applying = useUpdateStore((s) => s.applying);
  const apply = useUpdateStore((s) => s.apply);

  if (!available) return null;

  return (
    <div className={styles.viewport}>
      <button
        type="button"
        className={styles.prompt}
        onClick={apply}
        disabled={applying}
        aria-live="polite"
        title="A new version of DWEEB is ready — click to update"
      >
        <span className={styles.icon} aria-hidden="true">
          <RefreshIcon size={12} />
        </span>
        <span className={styles.label}>{applying ? "Updating…" : "Update available"}</span>
      </button>
    </div>
  );
}
