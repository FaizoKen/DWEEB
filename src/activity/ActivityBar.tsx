/**
 * The Activity's top bar — the one piece of chrome the embedded surface adds on
 * top of the reused editor: where the message is going (the channel), who else
 * is editing (presence), undo/redo, and the primary **Post** action.
 *
 * The web app's action bar (account menu, share links, restore, scheduling) is
 * deliberately absent: inside Discord the context is fixed and publishing is one
 * server-side call, so this stays focused on "edit together, then post".
 */

import { useMessageStore } from "@/core/state/messageStore";
import { useActivityStore } from "@/core/activity/activityStore";
import type { CollabParticipant } from "@/core/activity/collab";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import { RedoIcon, SendIcon, UndoIcon } from "@/ui/Icon";
import { ChannelPicker } from "./ChannelPicker";
import styles from "./ActivityBar.module.css";

export function ActivityBar() {
  const undo = useMessageStore((s) => s.undo);
  const redo = useMessageStore((s) => s.redo);
  const canUndo = useMessageStore((s) => s.past.length > 0);
  const canRedo = useMessageStore((s) => s.future.length > 0);

  const participants = useActivityStore((s) => s.participants);
  const publishing = useActivityStore((s) => s.publishing);
  const collabConnected = useActivityStore((s) => s.collabConnected);
  const publish = useActivityStore((s) => s.publish);
  const targetChannelId = useActivityStore((s) => s.targetChannelId);
  const setTargetChannel = useActivityStore((s) => s.setTargetChannel);

  return (
    <div className={styles.bar}>
      <div className={styles.left}>
        <ChannelPicker selectedId={targetChannelId} onSelect={setTargetChannel} />
        <span
          className={styles.dot}
          data-on={collabConnected ? "" : undefined}
          title={
            collabConnected
              ? "Live — your edits sync to everyone here"
              : "Reconnecting to the shared session…"
          }
        />
      </div>

      <div className={styles.center}>
        <Presence participants={participants} />
      </div>

      <div className={styles.right}>
        <IconButton label="Undo" onClick={undo} disabled={!canUndo}>
          <UndoIcon />
        </IconButton>
        <IconButton label="Redo" onClick={redo} disabled={!canRedo}>
          <RedoIcon />
        </IconButton>
        <Button
          variant="primary"
          size="sm"
          leadingIcon={<SendIcon />}
          onClick={() => void publish()}
          disabled={publishing || !targetChannelId}
          title="Post this message into the selected channel"
        >
          {publishing ? "Posting…" : "Post"}
        </Button>
      </div>
    </div>
  );
}

/** Overlapping initial-avatars of everyone currently in the room. Initials over
 *  CDN images so nothing depends on an external fetch inside the sandbox. */
function Presence({ participants }: { participants: CollabParticipant[] }) {
  if (participants.length === 0) return null;
  const shown = participants.slice(0, 5);
  const extra = participants.length - shown.length;
  return (
    <div
      className={styles.presence}
      title={`${participants.length} ${participants.length === 1 ? "person" : "people"} editing`}
    >
      {shown.map((p) => (
        <span key={p.id} className={styles.avatar} style={{ background: colorFor(p.id) }}>
          {initial(p.name)}
        </span>
      ))}
      {extra > 0 ? <span className={styles.more}>+{extra}</span> : null}
    </div>
  );
}

function initial(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase();
}

/** A stable, pleasant colour per user id (golden-angle hue around the wheel). */
function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h}deg 55% 45%)`;
}
