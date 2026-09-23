/**
 * Discord-style "Update" affordance.
 *
 * When a new build is waiting (see `updateStore`), a highlighted pill drops into
 * the top-right corner — the uncluttered preview side on desktop — instead of a
 * fleeting toast, so the prompt stays put until the user acts. Clicking it
 * activates the waiting service worker and reloads onto the new build; while
 * that's in flight the button shows progress and disables to avoid a double
 * trigger.
 *
 * It is portalled to <body> rather than rendered in the app shell: the shell
 * goes `inert` while the Message directory is open — which on a returning visit
 * is exactly when a waiting update gets noticed — so the pill sat there,
 * buried under the directory and unclickable. From <body> it layers above the
 * directory and dialogs, and `data-modal-live-region` keeps Modal from inerting
 * it. The region is mounted even while empty so the pill's arrival is announced.
 */

import { createPortal } from "react-dom";
import { useUpdateStore } from "@/core/state/updateStore";
import { RefreshIcon } from "@/ui/Icon";
import styles from "./UpdatePrompt.module.css";

export function UpdatePrompt() {
  const available = useUpdateStore((s) => s.available);
  const applying = useUpdateStore((s) => s.applying);
  const apply = useUpdateStore((s) => s.apply);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className={styles.viewport} role="status" data-modal-live-region="true">
      {available ? (
        <button
          type="button"
          className={styles.prompt}
          onClick={apply}
          disabled={applying}
          title="A new version of DWEEB is ready — click to update"
        >
          <span className={styles.icon} aria-hidden="true">
            <RefreshIcon size={12} />
          </span>
          <span className={styles.label}>{applying ? "Updating…" : "Update available"}</span>
        </button>
      ) : null}
    </div>,
    document.body,
  );
}
