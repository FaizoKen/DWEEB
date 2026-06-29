/**
 * The bottom-right "this is you" badge: the signed-in user's own avatar with a
 * live connection-status dot beside it (green = your edits are syncing, amber
 * pulsing = reconnecting). The roster of *other* editors lives in the top bar
 * (`ActivityBar`); this is the one piece of presence that's about you.
 *
 * It renders as a plain inline pill — the fixed bottom-right placement is the
 * wrapper's job in `ActivityApp`, so on mobile it can instead stack into the
 * floating fab column above the mini preview.
 */

import { useActivityStore } from "@/core/activity/activityStore";
import { Avatar } from "./Avatar";
import styles from "./SelfPresence.module.css";

export function SelfPresence() {
  const user = useActivityStore((s) => s.user);
  const connected = useActivityStore((s) => s.collabConnected);
  if (!user) return null;

  const status = connected
    ? "Live — your edits are syncing"
    : "Reconnecting to the shared session…";
  return (
    <div className={styles.self} title={`${user.name} · ${status}`}>
      <Avatar id={user.id} name={user.name} avatar={user.avatar} size={26} />
      <span className={styles.dot} data-on={connected ? "" : undefined} aria-label={status} />
    </div>
  );
}
