/**
 * The management list for scheduled posts.
 *
 * Sources are merged: every schedule this browser created (from the local
 * manage-token registry) plus, when signed in, the account's schedules across
 * devices (`listMine`). Each row shows status, the next run (in the schedule's
 * own timezone), and the last failure reason if any, with pause/resume, cancel,
 * and "load the message into the editor" actions.
 */

import { useCallback, useEffect, useState } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { useAuthStore } from "@/core/auth/authStore";
import { decodeJson } from "@/core/serialization";
import { validateMessage } from "@/core/schema/validation";
import { pushToast } from "@/ui/Toast";
import { cn } from "@/lib/cn";
import {
  cancelSchedule,
  getSchedule,
  listMine,
  updateSchedule,
  type ScheduleView,
} from "@/core/schedule/api";
import { forgetSchedule, getManageToken, loadLocalSchedules } from "@/core/schedule/localStore";
import { formatInstant, formatRecurrence, type Recurrence } from "@/core/schedule/recurrence";
import styles from "./SchedulePanel.module.css";

/** Sort: live schedules first (by soonest run), terminal ones last (by recency). */
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
}: {
  /** Bumped by the panel after a create, to refetch. */
  reloadToken: number;
  /** Called after a schedule's message is loaded into the editor (e.g. to close). */
  onLoaded?: () => void;
}) {
  const replaceMessage = useMessageStore((s) => s.replaceMessage);
  const authStatus = useAuthStore((s) => s.status);
  const [items, setItems] = useState<ScheduleView[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const byId = new Map<string, ScheduleView>();
    // The signed-in account's schedules (cross-device), best-effort.
    if (authStatus === "authed") {
      const mine = await listMine();
      if (mine.ok) for (const s of mine.items) byId.set(s.id, s);
    }
    // This browser's schedules, by manage token — fetched individually for any
    // not already covered by the account list. A 404 means it's gone; forget it.
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
    setLoading(false);
  }, [authStatus]);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  const handlePauseResume = async (s: ScheduleView) => {
    setBusyId(s.id);
    const res = await updateSchedule(
      s.id,
      { paused: s.status !== "paused" },
      getManageToken(s.id),
    );
    setBusyId(null);
    if (res.ok) {
      pushToast(res.schedule.status === "paused" ? "Schedule paused." : "Schedule resumed.", "success");
      void load();
    } else {
      pushToast(res.error, "error");
    }
  };

  const handleCancel = async (s: ScheduleView) => {
    setBusyId(s.id);
    const res = await cancelSchedule(s.id, getManageToken(s.id));
    setBusyId(null);
    if (res.ok) {
      forgetSchedule(s.id);
      pushToast("Schedule canceled.", "success");
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
        {loading ? "Loading your schedules…" : "No scheduled posts yet."}
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
          onPauseResume={() => handlePauseResume(s)}
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
  onPauseResume,
  onCancel,
  onLoad,
}: {
  schedule: ScheduleView;
  busy: boolean;
  onPauseResume: () => void;
  onCancel: () => void;
  onLoad: () => void;
}) {
  const recurrence = s.recurrence as Recurrence;
  const live = s.status === "active" || s.status === "sending" || s.status === "paused";
  return (
    <div className={styles.item}>
      <div className={styles.itemHead}>
        <span className={styles.itemTitle}>
          {s.title || s.dest_label || `Webhook ${s.webhook_id}`}
        </span>
        <span className={cn(styles.badge, badgeClass(s.status))}>{s.status}</span>
      </div>
      <div className={styles.itemMeta}>
        {formatRecurrence(recurrence)}
        {" · "}
        {live ? "Next" : s.status === "done" ? "Last ran" : "Last tried"}:{" "}
        {formatInstant(
          (live ? s.next_run_at : (s.last_run_at ?? s.next_run_at)) || s.next_run_at,
          s.tz,
        )}
        {s.runs_count > 0 ? ` · sent ${s.runs_count}×` : ""}
        {s.max_runs ? ` / ${s.max_runs}` : ""}
      </div>
      {s.last_error && (s.status === "failed" || s.attempts > 0) ? (
        <div className={styles.itemError}>⚠ {s.last_error}</div>
      ) : null}
      <div className={styles.itemActions}>
        {live ? (
          <button type="button" className={styles.smallBtn} onClick={onPauseResume} disabled={busy}>
            {s.status === "paused" ? "Resume" : "Pause"}
          </button>
        ) : (
          <button type="button" className={styles.smallBtn} onClick={onPauseResume} disabled={busy}>
            Reactivate
          </button>
        )}
        <button type="button" className={styles.smallBtn} onClick={onLoad} disabled={busy}>
          Load message
        </button>
        <button
          type="button"
          className={cn(styles.smallBtn, styles.smallBtnDanger)}
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
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
