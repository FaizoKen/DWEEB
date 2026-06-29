/**
 * Bottom-right presence dock — the single home for "who's here": everyone in the
 * room as a real avatar, a live connection-status dot (green = your edits are
 * syncing, amber pulsing = reconnecting), and a "+" that invites more people to
 * edit together (the action that used to be the header's share button).
 *
 * You're always shown first (sourced from the signed-in user, so your avatar
 * appears immediately — before the collaboration roster loads) and ringed in the
 * accent colour; everyone else comes from the roster.
 *
 * The dock is a fixed-width card sized to match the mobile mini preview above it,
 * so the two line up into one stacked unit. It renders as a plain block; the
 * placement (preview-pane corner on desktop, under the mini preview on mobile) is
 * the wrapper's job in `ActivityApp`.
 */

import type { CSSProperties } from "react";
import { useActivityStore } from "@/core/activity/activityStore";
import { PlusIcon } from "@/ui/Icon";
import { Avatar } from "./Avatar";
import styles from "./PresenceDock.module.css";

/** Avatars shown before collapsing the rest into a "+N" count. Kept low so the
 *  row, the dot, and the invite button all fit the fixed dock width. */
const MAX_SHOWN = 4;

export function PresenceDock() {
  const user = useActivityStore((s) => s.user);
  const participants = useActivityStore((s) => s.participants);
  const connected = useActivityStore((s) => s.collabConnected);
  const invite = useActivityStore((s) => s.invite);
  // Discord's invite dialog only works in a server context (it throws in DMs),
  // so the "+" is hidden on a DM / group-DM launch — same gate the old header
  // share button used.
  const canInvite = useActivityStore((s) => s.context?.guildId != null);
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
    <div className={styles.dock}>
      <div className={styles.stack} title={title}>
        {/* Your status lives in the ring around your own avatar: green when the
            collaboration socket is connected, amber (pulsing) while reconnecting
            — no separate dot. The colour is driven by a per-state `--ring` custom
            property so a single box-shadow rule renders it (no class-vs-attribute
            cascade to lose). */}
        <span
          className={`${styles.slot} ${styles.self}`}
          data-online={connected ? "" : undefined}
          style={
            { "--ring": connected ? "var(--app-success)" : "var(--app-warning)" } as CSSProperties
          }
          aria-label={status}
        >
          <Avatar id={user.id} name={user.name} avatar={user.avatar} size={24} />
        </span>
        {shownOthers.map((p) => (
          <span key={p.id} className={styles.slot}>
            <Avatar id={p.id} name={p.name} avatar={p.avatar} size={24} />
          </span>
        ))}
        {extra > 0 ? <span className={styles.more}>+{extra}</span> : null}
      </div>
      {canInvite ? (
        <button
          type="button"
          className={styles.add}
          onClick={() => void invite()}
          title="Invite people to edit together"
          aria-label="Invite people to edit together"
        >
          <PlusIcon size={16} />
        </button>
      ) : null}
    </div>
  );
}
