/**
 * The Scheduled tab's **history** section, rendered below the upcoming
 * preview-card grid in the "Start a message" gallery.
 *
 * Upcoming schedules are shown as normal gallery cards (with live previews) by
 * `TemplateGallery`; posted / failed ones can't be — the server deletes a
 * schedule's message once it fires — so they live here as compact rows with a
 * "View on Discord" jump (once posted) and a per-row / bulk remove, mirroring
 * the list the old "Managed messages" dialog used to own. Styling is shared
 * with that former dialog via `ScheduledList.module.css`.
 */

import { useState } from "react";
import { cn } from "@/lib/cn";
import { handleDiscordLinkClick } from "@/lib/discordDeepLink";
import { formatInstant } from "@/core/schedule/recurrence";
import type { ScheduleView } from "@/core/schedule/api";
import styles from "@/features/guild/ScheduledList.module.css";

/**
 * A posted message's interactive components are dead once the deployment's TTL
 * has elapsed since it fired — unless it claimed a never-expire slot. We can
 * only say so when the TTL is known.
 */
function isExpired(s: ScheduleView, ttlDays: number | null): boolean {
  if (ttlDays == null || s.status !== "done" || s.make_permanent) return false;
  const posted = s.last_run_at;
  if (posted == null) return false;
  return Date.now() / 1000 > posted + ttlDays * 86_400;
}

function badgeClass(status: string): string {
  switch (status) {
    case "failed":
      return styles.badgeFailed!;
    default:
      return styles.badgeDone!;
  }
}

export function ScheduleHistory({
  history,
  ttlDays,
  retentionDays,
  busyId,
  onRemove,
  onClear,
}: {
  history: ScheduleView[];
  /** Component TTL (days) for this deployment, for the "expired" badge. */
  ttlDays: number | null;
  /** Days a posted/failed row lingers before the worker sweeps it. */
  retentionDays: number | null;
  busyId: string | null;
  onRemove: (s: ScheduleView) => void;
  /** Clear every terminal row at once; resolves when the request settles. */
  onClear: () => Promise<void>;
}) {
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  if (history.length === 0) return null;

  const clear = async () => {
    setClearing(true);
    await onClear();
    setClearing(false);
    setConfirmingClear(false);
  };

  return (
    <div className={styles.group}>
      <div className={styles.groupHead}>
        <span className={styles.groupLabel}>History</span>
        <span className={styles.groupCount}>{history.length}</span>
        {confirmingClear ? (
          <span className={styles.clearConfirm}>
            <button
              type="button"
              className={cn(styles.linkBtn, styles.linkBtnDanger)}
              onClick={() => void clear()}
              disabled={clearing}
            >
              {clearing ? "Clearing…" : `Clear ${history.length}?`}
            </button>
            <button
              type="button"
              className={styles.linkBtn}
              onClick={() => setConfirmingClear(false)}
              disabled={clearing}
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            className={cn(styles.linkBtn, styles.clearAction)}
            onClick={() => setConfirmingClear(true)}
            title="Remove these posted & failed schedules from the list"
          >
            Clear
          </button>
        )}
      </div>
      <p className={styles.historyNote}>
        {retentionDays != null
          ? `Posted & failed posts clear automatically ${retentionDays} day${retentionDays === 1 ? "" : "s"} after they run — “Clear” just removes them now.`
          : "Posted & failed posts clear automatically after a while — “Clear” just removes them now."}
      </p>
      <div className={cn(styles.list, history.length > 6 && styles.historyScroll)}>
        {history.map((s) => (
          <HistoryRow
            key={s.id}
            schedule={s}
            busy={busyId === s.id}
            expired={isExpired(s, ttlDays)}
            onRemove={() => onRemove(s)}
          />
        ))}
      </div>
    </div>
  );
}

function HistoryRow({
  schedule: s,
  busy,
  expired,
  onRemove,
}: {
  schedule: ScheduleView;
  busy: boolean;
  expired: boolean;
  onRemove: () => void;
}) {
  const when = s.last_run_at ?? s.next_run_at;
  // A direct jump to the message the last run posted — only once we have all
  // three id parts (guild + channel/thread + message), captured at fire time.
  const postedUrl =
    s.guild_id && s.last_channel_id && s.last_message_id
      ? `https://discord.com/channels/${s.guild_id}/${s.last_channel_id}/${s.last_message_id}`
      : null;
  const lead = s.status === "failed" ? "Failed" : "Posted";
  return (
    <div className={cn(styles.item, s.status === "done" && styles.itemDim)}>
      <div className={styles.itemHead}>
        <span className={styles.itemTitle}>
          {s.title || s.dest_label || `Webhook ${s.webhook_id}`}
        </span>
        {expired ? (
          <span
            className={cn(styles.badge, styles.badgeExpired)}
            title="This post's buttons & selects have stopped working"
          >
            expired
          </span>
        ) : (
          <span className={cn(styles.badge, badgeClass(s.status))}>{s.status}</span>
        )}
      </div>
      <div className={styles.itemMeta}>
        {lead} {formatInstant(when, s.tz)}
      </div>
      {s.last_error && s.status === "failed" ? (
        <div className={styles.itemError}>⚠ {s.last_error}</div>
      ) : null}
      <div className={styles.itemActions}>
        {postedUrl ? (
          <a
            className={cn(styles.smallBtn, styles.viewBtn)}
            href={postedUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(ev) => handleDiscordLinkClick(ev, postedUrl)}
          >
            View on Discord ↗
          </a>
        ) : null}
        <button
          type="button"
          className={cn(styles.smallBtn, styles.smallBtnDanger)}
          onClick={onRemove}
          disabled={busy}
        >
          Remove
        </button>
      </div>
    </div>
  );
}
