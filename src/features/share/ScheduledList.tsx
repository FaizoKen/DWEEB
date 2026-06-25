/**
 * Compact list of the user's scheduled (one-time) posts, shown inside the Send
 * panel's "Schedule for later" card.
 *
 * Sources are merged: every schedule this browser created (from the local
 * manage-token registry) plus, when signed in, the account's schedules across
 * devices (`listMine`). Each row shows when it posts (or that it posted /
 * failed) and offers cancel + "load the message back into the editor".
 */

import { useCallback, useEffect, useState } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { useAuthStore } from "@/core/auth/authStore";
import { decodeJson } from "@/core/serialization";
import { validateMessage } from "@/core/schema/validation";
import { pushToast } from "@/ui/Toast";
import { cn } from "@/lib/cn";
import { cancelSchedule, getSchedule, listMine, type ScheduleView } from "@/core/schedule/api";
import { forgetSchedule, getManageToken, loadLocalSchedules } from "@/core/schedule/localStore";
import { formatInstant } from "@/core/schedule/recurrence";
import styles from "./ScheduleSection.module.css";

/** Live (still going to post) first, then posted/failed by recency. */
const STATUS_ORDER: Record<string, number> = {
  active: 0,
  sending: 0,
  paused: 1,
  failed: 2,
  done: 3,
};

export function ScheduledList({
  reloadToken,
  onLoaded,
  onCount,
}: {
  /** Bumped by the section after a create, to refetch. */
  reloadToken: number;
  /** Called after a schedule's message is loaded into the editor (e.g. to close). */
  onLoaded?: () => void;
  /** Reports how many schedules exist, so the card can show a count. */
  onCount?: (n: number) => void;
}) {
  const replaceMessage = useMessageStore((s) => s.replaceMessage);
  const authStatus = useAuthStore((s) => s.status);
  const [items, setItems] = useState<ScheduleView[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const byId = new Map<string, ScheduleView>();
    if (authStatus === "authed") {
      const mine = await listMine();
      if (mine.ok) for (const s of mine.items) byId.set(s.id, s);
    }
    const local = loadLocalSchedules();
    await Promise.all(
      local.map(async (entry) => {
        if (byId.has(entry.id)) return;
        const res = await getSchedule(entry.id, entry.manageToken);
        if (res.ok) byId.set(entry.id, res.schedule);
        else if (res.status === 404) forgetSchedule(entry.id);
      }),
    );
    const list = [...byId.values()].sort((a, b) => {
      const pa = STATUS_ORDER[a.status] ?? 9;
      const pb = STATUS_ORDER[b.status] ?? 9;
      if (pa !== pb) return pa - pb;
      return a.next_run_at - b.next_run_at;
    });
    setItems(list);
    onCount?.(list.length);
    setLoading(false);
  }, [authStatus, onCount]);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  const handleCancel = async (s: ScheduleView) => {
    setBusyId(s.id);
    const res = await cancelSchedule(s.id, getManageToken(s.id));
    setBusyId(null);
    if (res.ok) {
      forgetSchedule(s.id);
      pushToast("Scheduled post canceled.", "success");
      void load();
    } else {
      pushToast(res.error, "error");
    }
  };

  const handleLoad = async (s: ScheduleView) => {
    setBusyId(s.id);
    const res = await getSchedule(s.id, getManageToken(s.id));
    setBusyId(null);
    if (!res.ok || res.schedule.payload == null) {
      pushToast(res.ok ? "That schedule has no message to load." : res.error, "error");
      return;
    }
    const decoded = decodeJson(JSON.stringify(res.schedule.payload));
    if (!decoded.ok) {
      pushToast(`Couldn't load that message: ${decoded.error}`, "error");
      return;
    }
    replaceMessage(decoded.message);
    const validation = validateMessage(decoded.message);
    pushToast(
      validation.ok
        ? "Loaded the scheduled message into the editor."
        : `Loaded with ${validation.issues.length} validation issue${validation.issues.length === 1 ? "" : "s"}.`,
      validation.ok ? "success" : "info",
    );
    onLoaded?.();
  };

  if (items.length === 0) {
    return (
      <p className={styles.empty}>
        {loading ? "Loading your scheduled posts…" : "No scheduled posts yet."}
      </p>
    );
  }

  return (
    <div className={styles.list}>
      {items.map((s) => (
        <ScheduleRow
          key={s.id}
          schedule={s}
          busy={busyId === s.id}
          onCancel={() => handleCancel(s)}
          onLoad={() => handleLoad(s)}
        />
      ))}
    </div>
  );
}

function ScheduleRow({
  schedule: s,
  busy,
  onCancel,
  onLoad,
}: {
  schedule: ScheduleView;
  busy: boolean;
  onCancel: () => void;
  onLoad: () => void;
}) {
  const live = s.status === "active" || s.status === "sending" || s.status === "paused";
  const when = live ? s.next_run_at : (s.last_run_at ?? s.next_run_at);
  const lead =
    s.status === "done"
      ? "Posted"
      : s.status === "failed"
        ? "Failed"
        : s.status === "paused"
          ? "Paused — was"
          : "Posts";
  return (
    <div className={styles.item}>
      <div className={styles.itemHead}>
        <span className={styles.itemTitle}>
          {s.title || s.dest_label || `Webhook ${s.webhook_id}`}
        </span>
        <span className={cn(styles.badge, badgeClass(s.status))}>{s.status}</span>
      </div>
      <div className={styles.itemMeta}>
        {lead} {formatInstant(when, s.tz)}
      </div>
      {s.last_error && s.status === "failed" ? (
        <div className={styles.itemError}>⚠ {s.last_error}</div>
      ) : null}
      <div className={styles.itemActions}>
        <button type="button" className={styles.smallBtn} onClick={onLoad} disabled={busy}>
          Load message
        </button>
        <button
          type="button"
          className={cn(styles.smallBtn, styles.smallBtnDanger)}
          onClick={onCancel}
          disabled={busy}
        >
          {s.status === "done" || s.status === "failed" ? "Remove" : "Cancel"}
        </button>
      </div>
    </div>
  );
}

function badgeClass(status: string): string {
  switch (status) {
    case "paused":
      return styles.badgePaused!;
    case "done":
      return styles.badgeDone!;
    case "failed":
      return styles.badgeFailed!;
    default:
      return styles.badgeActive!;
  }
}
