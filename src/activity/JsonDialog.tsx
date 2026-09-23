/**
 * Import / export the Activity's shared message as JSON.
 *
 * A thin Modal around the same {@link JsonPanel} the web Share dialog uses:
 * copy/download the wire-format payload, or paste JSON / a share link / a V1
 * payload to replace the draft. It's pure client-side — no Activity bearer call
 * needed. An import runs through `replaceMessage`, which the collab layer
 * broadcasts to the room as a full draft, so every collaborator sees the swap
 * (the same path Restore and "load a draft" already take) — which is why it
 * asks first while others are editing (`requestRoomReplace`).
 */

import { Modal } from "@/ui/Modal";
import { JsonPanel } from "@/features/share/JsonPanel";
import { requestRoomReplace } from "@/core/activity/roomReplaceConfirm";

export function JsonDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Import / export JSON">
      <JsonPanel
        onDone={onClose}
        confirmReplace={(apply) =>
          requestRoomReplace({
            action: "Importing this JSON",
            confirmLabel: "Import for everyone",
            run: apply,
          })
        }
      />
    </Modal>
  );
}
