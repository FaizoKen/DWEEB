/**
 * List of the user's scheduled (one-time) posts, shown in the "Managed
 * messages" dialog. Split into two groups: Upcoming (still going to fire) and
 * History (posted/failed) — the latter de-emphasised and bulk-clearable, since
 * it otherwise piles up as a wall of identical "done" rows.
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
import { handleDiscordLinkClick } from "@/lib/discordDeepLink";
import {
  cancelSchedule,
  getSchedule,
  listForGuild,
  listMine,
  type ScheduleView,
} from "@/core/schedule/api";
import { forgetSchedule, getManageToken, loadLocalSchedules } from "@/core/schedule/localStore";
import { formatInstant } from "@/core/schedule/recurrence";
import styles from "./ScheduledList.module.css";

/** Live (still going to post) first, then posted/failed by recency. */
const STATUS_ORDER: Record<string, number> = {
  active: 0,
  sending: 0,
  paused: 1,
  failed: 2,
  done: 3,
};

/** Statuses that are still going to fire — everything else is terminal history. */
const UPCOMING = new Set(["active", "sending", "paused"]);

/** What the parent header needs to render the "used / cap" counter. */
export interface ScheduleStats {
  /** All schedules in the list. */
  total: number;
  /** Live ones (active/sending/paused) — what the per-server quota counts. */
  active: number;
  /** Per-server active-schedule cap, when the server list exposed it. */
  quota: number | null;
}

export function ScheduledList({
  reloadToken,
  guildId,
  ttlDays,
  onLoaded,
  onStats,
}: {
  /** Bumped by the section after a create, to refetch. */
  reloadToken: number;
  /** When set and the user manages it, also list EVERY schedule for that server. */
  guildId?: string;
  /** Component TTL (days) for this deployment — lets posted rows show "Expired"
   *  once their buttons/selects have lapsed. Null/undefined = never expires. */
  ttlDays?: number | null;
  /** Called after a schedule's message is loaded into the editor (e.g. to close). */
  onLoaded?: () => void;
  /** Reports counts + quota, so the header can show "used / cap". */
  onStats?: (s: ScheduleStats) => void;
}) {
  const replaceMessage = useMessageStore((s) => s.replaceMessage);
  const authStatus = useAuthStore((s) => s.status);
  const [items, setItems] = useState<ScheduleView[]>([]);
  // Days a posted/failed row is kept before the worker sweeps it (server config).
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Two-step guard for the bulk "Clear" of history (terminal posts).
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const byId = new Map<string, ScheduleView>();
    let guildQuota: number | null = null;
    let guildRetention: number | null = null;
    // Every schedule for the current server, if the user manages it (403 for
    // non-managers is ignored — they still see their own below).
    if (guildId) {
      const guild = await listForGuild(guildId);
      if (guild.ok) {
        for (const s of guild.items) byId.set(s.id, s);
        guildQuota = guild.quota ?? null;
        guildRetention = guild.retentionDays ?? null;
      }
    }
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
    setRetentionDays(guildRetention);
    onStats?.({
      total: list.length,
      // The per-server quota only counts live schedules *in this guild* — the
      // merged list can also carry the user's schedules from other servers.
      active: list.filter((s) => UPCOMING.has(s.status) && (!guildId || s.guild_id === guildId))
        .length,
      quota: guildQuota,
    });
    setLoading(false);
  }, [authStatus, guildId, onStats]);

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

  // Remove every terminal (posted/failed) schedule in one go — pure history
  // cleanup, since these will never fire again. Reuses the per-row delete path.
  const handleClearHistory = async (history: ScheduleView[]) => {
    setClearing(true);
    const results = await Promise.all(
      history.map((s) => cancelSchedule(s.id, getManageToken(s.id))),
    );
    for (const s of history) forgetSchedule(s.id);
    setClearing(false);
    setConfirmingClear(false);
    const failed = results.filter((r) => !r.ok).length;
    pushToast(
      failed === 0
        ? "Cleared posted & failed schedules."
        : `Cleared ${results.length - failed}; ${failed} couldn't be removed.`,
      failed === 0 ? "success" : "info",
    );
    void load();
  };

  if (items.length === 0) {
    return (
      <p className={styles.empty}>
        {loading ? "Loading your scheduled posts…" : "No scheduled posts yet."}
      </p>
    );
  }

  const upcoming = items.filter((s) => UPCOMING.has(s.status));
  const history = items.filter((s) => !UPCOMING.has(s.status));

  return (
    <div className={styles.groups}>
      {upcoming.length > 0 ? (
        <div className={styles.group}>
          <div className={styles.groupHead}>
            <span className={styles.groupLabel}>Upcoming</span>
            <span className={styles.groupCount}>{upcoming.length}</span>
          </div>
          <div className={styles.list}>
            {upcoming.map((s) => (
              <ScheduleRow
                key={s.id}
                schedule={s}
                busy={busyId === s.id}
                onCancel={() => handleCancel(s)}
                onLoad={() => handleLoad(s)}
              />
            ))}
          </div>
        </div>
      ) : null}

      {history.length > 0 ? (
        <div className={styles.group}>
          <div className={styles.groupHead}>
            <span className={styles.groupLabel}>History</span>
            <span className={styles.groupCount}>{history.length}</span>
            {confirmingClear ? (
              <span className={styles.clearConfirm}>
                <button
                  type="button"
                  className={cn(styles.linkBtn, styles.linkBtnDanger)}
                  onClick={() => void handleClearHistory(history)}
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
              <ScheduleRow
                key={s.id}
                schedule={s}
                busy={busyId === s.id}
                dimmed={s.status === "done"}
                expired={isExpired(s, ttlDays)}
                onCancel={() => handleCancel(s)}
                onLoad={() => handleLoad(s)}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A posted message's interactive components are dead once the deployment's TTL
 * has elapsed since it fired — unless it claimed a never-expire slot. We can
 * only say so when the TTL is known (the never-expire fetch succeeded).
 */
function isExpired(s: ScheduleView, ttlDays: number | null | undefined): boolean {
  if (ttlDays == null || s.status !== "done" || s.make_permanent) return false;
  const posted = s.last_run_at;
  if (posted == null) return false;
  return Date.now() / 1000 > posted + ttlDays * 86_400;
}

function ScheduleRow({
  schedule: s,
  busy,
  dimmed = false,
  expired = false,
  onCancel,
  onLoad,
}: {
  schedule: ScheduleView;
  busy: boolean;
  /** Posted rows are de-emphasised so the actionable ones read first. */
  dimmed?: boolean;
  /** Done, but its buttons/selects have lapsed past the deployment TTL. */
  expired?: boolean;
  onCancel: () => void;
  onLoad: () => void;
}) {
  const live = s.status === "active" || s.status === "sending" || s.status === "paused";
  const when = live ? s.next_run_at : (s.last_run_at ?? s.next_run_at);
  // A direct jump to the message the last run posted — only once we have all
  // three id parts (guild + channel/thread + message), captured at fire time.
  const postedUrl =
    s.guild_id && s.last_channel_id && s.last_message_id
      ? `https://discord.com/channels/${s.guild_id}/${s.last_channel_id}/${s.last_message_id}`
      : null;
  const lead =
    s.status === "done"
      ? "Posted"
      : s.status === "failed"
        ? "Failed"
        : s.status === "paused"
          ? "Paused — was"
          : "Posts";
  return (
    <div className={cn(styles.item, dimmed && styles.itemDim)}>
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
          // Once posted, jump to the real message instead of reloading it into
          // the editor. Plain click opens the desktop app (falls back to web);
          // modified clicks keep their native open-in-new-tab behaviour.
          <a
            className={cn(styles.smallBtn, styles.viewBtn)}
            href={postedUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(ev) => handleDiscordLinkClick(ev, postedUrl)}
          >
            View on Discord ↗
          </a>
        ) : (
          // Not posted yet (or no link captured) — offer the message back.
          <button type="button" className={styles.smallBtn} onClick={onLoad} disabled={busy}>
            Load message
          </button>
        )}
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
