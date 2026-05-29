/**
 * Confirmation popup for clearing interactive components.
 *
 * Surfaced from the Send panel's "this webhook isn't app-owned" block: the
 * user closes the Share dialog (back to the editor) and is then asked to
 * confirm before we delete the buttons/select menus Discord would reject.
 *
 * Lives at the App level (not inside the Share dialog) so it survives the
 * dialog closing — the whole point is that it appears over the editor.
 */

import { useMemo } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { inspectCapabilities } from "@/core/schema/capability";
import { Modal } from "@/ui/Modal";
import { Button } from "@/ui/Button";
import { pushToast } from "@/ui/Toast";
import styles from "./RemoveInteractiveConfirm.module.css";

export function RemoveInteractiveConfirm({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const message = useMessageStore((s) => s.message);
  const stripInteractive = useMessageStore((s) => s.stripInteractive);

  // Count using the same inspector the block relies on, so the number shown
  // matches exactly what will be cleared.
  const count = useMemo(() => {
    const note = inspectCapabilities(message).find((c) => c.kind === "app_webhook");
    return note?.nodes?.length ?? 0;
  }, [message]);

  const plural = count === 1 ? "" : "s";

  const handleConfirm = () => {
    const removed = stripInteractive();
    pushToast(
      removed > 0
        ? `Cleared ${removed} interactive component${removed === 1 ? "" : "s"}.`
        : "No interactive components to clear.",
      "success",
    );
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title="Clear interactive components?"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={handleConfirm} disabled={count === 0}>
            Clear {count} component{plural}
          </Button>
        </>
      }
    >
      <p className={styles.text}>
        This removes {count} interactive component{plural} — buttons with a <code>custom_id</code>{" "}
        and select menus — so the message can be sent through a webhook that isn’t owned by an app.
      </p>
      <p className={styles.text}>
        Link buttons and everything else stay. A Section’s required button accessory is downgraded
        to a link button. You can undo this with <kbd>Ctrl</kbd>+<kbd>Z</kbd>.
      </p>
    </Modal>
  );
}
