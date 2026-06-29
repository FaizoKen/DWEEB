/**
 * Bottom-right presence dock — the single home for "who's here": every person
 * currently in the room as a real avatar, plus a live connection-status dot
 * (green = your edits are syncing, amber pulsing = reconnecting).
 *
 * You're always shown first (sourced from the signed-in user, so your own
 * avatar appears immediately — before the collaboration roster has even loaded)
 * and marked with an accent ring; everyone else comes from the roster. This
 * replaces the old split where you sat in a bottom badge and the others sat up
 * in the top bar — now all of presence lives in one place.
 *
 * It renders as a plain inline pill; the fixed bottom-right placement is the
 * wrapper's job in `ActivityApp`, so on mobile it can instead stack into the
 * floating fab column above the mini preview.
 */

import { useActivityStore } from "@/core/activity/activityStore";
import { Avatar } from "./Avatar";
import styles from "./PresenceDock.module.css";

/** Avatars shown before collapsing the rest into a "+N" count. */
const MAX_SHOWN = 5;

export function PresenceDock() {
  const user = useActivityStore((s) => s.user);
  const participants = useActivityStore((s) => s.participants);
  const connected = useActivityStore((s) => s.collabConnected);
  if (!user) return null;

  // You first (always present), then everyone else from the room roster, deduped
  // against you — the roster is keyed by Discord user id and includes you.
  const others = participants.filter((p) => p.id !== user.id);
  const shownOthers = others.slice(0, MAX_SHOWN - 1);
  const extra = others.length - shownOthers.length;

  const count = others.length + 1;
  const status = connected
    ? "Live — your edits are syncing"
    : "Reconnecting to the shared session…";
  const title = `${count === 1 ? "Just you" : `${count} people`} editing · ${status}`;

  return (
    <div className={styles.dock} title={title}>
      <div className={styles.stack}>
        <span className={`${styles.slot} ${styles.self}`}>
          <Avatar id={user.id} name={user.name} avatar={user.avatar} size={26} />
        </span>
        {shownOthers.map((p) => (
          <span key={p.id} className={styles.slot}>
            <Avatar id={p.id} name={p.name} avatar={p.avatar} size={26} />
          </span>
        ))}
        {extra > 0 ? <span className={styles.more}>+{extra}</span> : null}
      </div>
      <span className={styles.dot} data-on={connected ? "" : undefined} aria-label={status} />
    </div>
  );
}
