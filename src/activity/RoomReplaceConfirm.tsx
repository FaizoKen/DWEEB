/**
 * "Replace the draft for everyone?" — the confirm behind every whole-draft
 * action in the room (see `core/activity/roomReplaceConfirm`). Mounted once by
 * the Activity shell; it only ever opens when someone else is editing and the
 * draft holds work, so solo use never sees it.
 *
 * Also exports {@link RoomReplaceNote}, the same warning as an inline line for a
 * flow that is already a confirmation step (Restore's channel switch), so that
 * flow doesn't stack a second dialog on top of its own.
 */

import { useMemo } from "react";
import { useActivityStore } from "@/core/activity/activityStore";
import { useMessageStore } from "@/core/state/messageStore";
import {
  editingTogetherPhrase,
  needsRoomReplaceConfirm,
  otherEditors,
} from "@/core/activity/roomReplace";
import {
  cancelRoomReplace,
  confirmRoomReplace,
  useRoomReplaceStore,
} from "@/core/activity/roomReplaceConfirm";
import { Button } from "@/ui/Button";
import { Modal } from "@/ui/Modal";
import styles from "./RoomReplaceConfirm.module.css";

/** The other people editing, read live so the count stays true while it's open. */
function useOtherEditors() {
  const participants = useActivityStore((s) => s.participants);
  const selfId = useActivityStore((s) => s.user?.id);
  return useMemo(() => otherEditors(participants, selfId), [participants, selfId]);
}

export function RoomReplaceConfirm() {
  const pending = useRoomReplaceStore((s) => s.pending);
  const others = useOtherEditors();
  return (
    <Modal
      open={pending != null}
      onClose={cancelRoomReplace}
      size="sm"
      title="Replace the draft for everyone?"
      // The Message directory asks from over its full-screen overlay (which sits
      // at --app-z-tooltip), so lift the confirm and its scrim above it.
      backdropStyle={{ zIndex: "calc(var(--app-z-tooltip) + 10)" }}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={cancelRoomReplace}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" onClick={confirmRoomReplace}>
            {pending?.confirmLabel ?? "Replace for everyone"}
          </Button>
        </>
      }
    >
      <p className={styles.lead}>
        <strong>{editingTogetherPhrase(others)}</strong> are editing this draft.{" "}
        {pending?.action ?? "This"} replaces it for everyone in this room, not just for you.
      </p>
    </Modal>
  );
}

/**
 * The same warning as one line, for a step that already asks for confirmation.
 * `action` continues the sentence in lower case ("restoring that message"). Renders
 * nothing when the confirm wouldn't be asked for (solo, or nothing to lose), and
 * follows every edit to the draft to stay accurate — so mount it only while that
 * step is on screen.
 */
export function RoomReplaceNote({ action }: { action: string }) {
  const others = useOtherEditors();
  const participants = useActivityStore((s) => s.participants);
  const selfId = useActivityStore((s) => s.user?.id);
  const message = useMessageStore((s) => s.message);
  const needed = useMemo(
    () => needsRoomReplaceConfirm(message, participants, selfId),
    [message, participants, selfId],
  );
  if (!needed) return null;
  return (
    <p className={styles.note}>
      <strong>{editingTogetherPhrase(others)}</strong> are editing this draft — {action} replaces it
      for everyone in this room.
    </p>
  );
}
