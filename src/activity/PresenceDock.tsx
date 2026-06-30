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
  // The "+" pulls more people into the room everywhere now. A server launch
  // opens Discord's native invite dialog; a DM / group-DM launch (no guild)
  // opens the share-link modal instead, since the invite dialog throws there.
  // The store's `invite()` picks the route — here we only vary the wording.
  const inDm = useActivityStore((s) => s.context?.guildId == null);
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

  // The avatar cluster, shared by both the clickable (invitable) and plain dock.
  // Your status lives in the ring around your own avatar: green when connected,
  // amber (pulsing) while reconnecting — no separate dot. The colour is driven by
  // an inline `--ring` custom property so a single box-shadow rule renders it.
  const people = (
    <div className={styles.stack} title={title}>
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
  );

  // The whole bar is the invite control (the "+" on the left is just its
  // affordance) — clicking anywhere on it pulls more people in. The label tracks
  // the route the store takes: a server launch opens the invite dialog, a DM /
  // group DM opens the share-link modal.
  const label = inDm ? "Share this session to edit together" : "Invite people to edit together";
  return (
    <button
      type="button"
      className={`${styles.dock} ${styles.invite}`}
      onClick={() => void invite()}
      title={label}
      aria-label={label}
    >
      <span className={styles.add} aria-hidden="true">
        <PlusIcon size={16} />
      </span>
      {people}
    </button>
  );
}
