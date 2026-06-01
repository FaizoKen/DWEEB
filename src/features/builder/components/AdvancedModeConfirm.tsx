/**
 * Confirmation dialog for switching on Advanced mode.
 *
 * Advanced mode unlocks the raw Discord plumbing — custom_id, snowflake lists,
 * emoji/SKU ids, forum-only fields — that we deliberately hide from the default
 * editor. Those fields are easy to get wrong, so we confirm before revealing
 * them. Shown on every activation; turning Advanced mode *off* never routes
 * through here.
 *
 * Presentational only: it owns no state and hands the decision back through
 * `onConfirm` / `onCancel`.
 */

import { Modal } from "@/ui/Modal";
import { Button } from "@/ui/Button";
import styles from "./AdvancedModeConfirm.module.css";

export function AdvancedModeConfirm({
  open,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      size="sm"
      title="Activate Advanced mode?"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm}>
            Activate
          </Button>
        </>
      }
    >
      <p className={styles.text}>
        This reveals raw Discord fields — <code>custom_id</code>, snowflake IDs, emoji/SKU IDs and
        forum options — that the editor normally hides. They&apos;re for power users and easy to get
        wrong, so leave them blank if unsure. You can switch Advanced mode off again anytime.
      </p>
    </Modal>
  );
}
