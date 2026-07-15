/**
 * Import / export the Activity's shared message as JSON.
 *
 * A thin Modal around the same {@link JsonPanel} the web Share dialog uses:
 * copy/download the wire-format payload, or paste JSON / a share link / a V1
 * payload to replace the draft. It's pure client-side — no Activity bearer call
 * needed. An import runs through `replaceMessage`, which the collab layer
 * broadcasts to the room as a full draft, so every collaborator sees the swap
 * (the same path Restore and "load a draft" already take).
 */

import { Modal } from "@/ui/Modal";
import { JsonPanel } from "@/features/share/JsonPanel";

export function JsonDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Import / export JSON">
      <JsonPanel onDone={onClose} />
    </Modal>
  );
}
