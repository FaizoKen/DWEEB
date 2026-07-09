/**
 * Data hook for the "Start a message" gallery's **Scheduled** tab.
 *
 * Owns the same merged view the old "Managed messages" dialog built — every
 * schedule this browser created (local manage-token registry) plus, when signed
 * in, the account's schedules across devices (`listMine`) and, for a server
 * manager, every schedule for the connected server (`listForGuild`). On top of
 * that it lazily fetches each *upcoming* schedule's decrypted message so the
 * gallery can show a live preview thumbnail (the same one every other card
 * carries) and load it straight back into the editor.
 *
 * History rows (posted / failed) have no payload — the server deletes the
 * message once it fires — so previews only exist for upcoming posts.
 *
 * `enabled` gates the list fetch (scheduling configured + gallery open);
 * `fetchPayloads` gates the extra per-schedule payload fetches (the user is
 * actually looking at the Scheduled tab), so a user who never opens it pays
 * nothing beyond the one cheap list call.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuthStore } from "@/core/auth/authStore";
import { decodeJson } from "@/core/serialization";
import type { WebhookMessage } from "@/core/schema/types";
import { cancelSchedule, getSchedule, listForGuild, listMine, type ScheduleView } from "./api";
import { forgetSchedule, getManageToken, loadLocalSchedules } from "./localStore";

/** Live (still going to post) first, then posted/failed by recency. */
const STATUS_ORDER: Record<string, number> = {
  active: 0,
  sending: 0,
  paused: 1,
  suspended: 1.5,
  failed: 2,
  done: 3,
};

/** Statuses that are still going to fire (or will once resumed). `suspended` is
 *  a plan-paused schedule (server over its tier cap): it keeps its slot and
 *  resumes on re-upgrade, so it belongs with the upcoming ones, not history. */
const UPCOMING = new Set(["active", "sending", "paused", "suspended"]);

/** The subset of live statuses that count against the per-server quota — the
 *  over-cap `suspended` overflow is deliberately excluded, matching the backend. */
const QUOTA_COUNTED = new Set(["active", "sending", "paused"]);

export interface ScheduledPostsData {
  /** The list request is in flight (first load or a reload). */
  loading: boolean;
  /** True once the list has answered at least once for the current inputs. */
  loaded: boolean;
  /** Still-going-to-fire schedules (active / sending / paused / suspended). */
  upcoming: ScheduleView[];
  /** Terminal schedules (posted / failed) — history, no payload to preview. */
  history: ScheduleView[];
  /** Decoded message per upcoming schedule id, for previews + editor load.
   *  Absent = not fetched yet; null = fetch failed / no payload. */
  messages: Map<string, WebhookMessage | null>;
  /** A payload fetch for the upcoming previews is in flight. */
  payloadsLoading: boolean;
  /** Live schedules for this server — what the per-server quota counts. */
  activeCount: number;
  /** Per-server active-schedule cap, when the server list exposed it. */
  quota: number | null;
  /** Days a posted/failed row lingers before the worker sweeps it. */
  retentionDays: number | null;
  /** Id of the schedule a cancel/remove is currently mutating. */
  busyId: string | null;
  reload(): void;
  /** Cancel/remove one schedule; resolves true on success. Optimistically drops
   *  it from the list so the grid updates without a full refetch. */
  cancel(s: ScheduleView): Promise<boolean>;
  /** Remove every terminal row in one go; resolves the count that failed. */
  clearHistory(history: ScheduleView[]): Promise<number>;
}

export function useScheduledPosts(
  guildId: string | undefined,
  enabled: boolean,
  fetchPayloads: boolean,
): ScheduledPostsData {
  const authStatus = useAuthStore((s) => s.status);
  const [items, setItems] = useState<ScheduleView[]>([]);
  const [messages, setMessages] = useState<Map<string, WebhookMessage | null>>(new Map());
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [payloadsLoading, setPayloadsLoading] = useState(false);
  const [quota, setQuota] = useState<number | null>(null);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => setReloadToken((t) => t + 1), []);

  // A new connected server means an entirely different set of schedules — drop
  // any cached previews so a stale one can't flash under a new server's card.
  useEffect(() => {
    setMessages(new Map());
    setLoaded(false);
  }, [guildId]);

  // Merge the three sources into one deduped, status-sorted list.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const byId = new Map<string, ScheduleView>();
      let guildQuota: number | null = null;
      let guildRetention: number | null = null;
      // Every schedule for the connected server, if the user manages it (a 403
      // for a non-manager is ignored — they still see their own below).
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
      if (cancelled) return;
      const list = [...byId.values()].sort((a, b) => {
        const pa = STATUS_ORDER[a.status] ?? 9;
        const pb = STATUS_ORDER[b.status] ?? 9;
        if (pa !== pb) return pa - pb;
        return a.next_run_at - b.next_run_at;
      });
      setItems(list);
      setQuota(guildQuota);
      setRetentionDays(guildRetention);
      setLoading(false);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, guildId, authStatus, reloadToken]);

  // Fetch the decrypted message for every upcoming schedule we don't have yet,
  // so the tab's cards carry a real preview. Only runs while the tab is open.
  useEffect(() => {
    if (!enabled || !fetchPayloads) return;
    const missing = items.filter((s) => UPCOMING.has(s.status) && !messages.has(s.id));
    if (missing.length === 0) return;
    let cancelled = false;
    setPayloadsLoading(true);
    void (async () => {
      const results = await Promise.all(
        missing.map(async (s) => {
          const res = await getSchedule(s.id, getManageToken(s.id));
          if (!res.ok || res.schedule.payload == null) return [s.id, null] as const;
          const decoded = decodeJson(JSON.stringify(res.schedule.payload));
          return [s.id, decoded.ok ? decoded.message : null] as const;
        }),
      );
      if (cancelled) return;
      setMessages((prev) => {
        const next = new Map(prev);
        for (const [id, m] of results) next.set(id, m);
        return next;
      });
      setPayloadsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, fetchPayloads, items, messages]);

  const cancel = useCallback(async (s: ScheduleView): Promise<boolean> => {
    setBusyId(s.id);
    const res = await cancelSchedule(s.id, getManageToken(s.id));
    setBusyId(null);
    if (!res.ok) return false;
    forgetSchedule(s.id);
    setItems((prev) => prev.filter((i) => i.id !== s.id));
    return true;
  }, []);

  const clearHistory = useCallback(async (history: ScheduleView[]): Promise<number> => {
    const results = await Promise.all(
      history.map((s) => cancelSchedule(s.id, getManageToken(s.id))),
    );
    for (const s of history) forgetSchedule(s.id);
    const ids = new Set(history.map((s) => s.id));
    setItems((prev) => prev.filter((i) => !ids.has(i.id)));
    return results.filter((r) => !r.ok).length;
  }, []);

  const upcoming = useMemo(() => items.filter((s) => UPCOMING.has(s.status)), [items]);
  const history = useMemo(() => items.filter((s) => !UPCOMING.has(s.status)), [items]);
  const activeCount = useMemo(
    () =>
      items.filter((s) => QUOTA_COUNTED.has(s.status) && (!guildId || s.guild_id === guildId))
        .length,
    [items, guildId],
  );

  return {
    loading,
    loaded,
    upcoming,
    history,
    messages,
    payloadsLoading,
    activeCount,
    quota,
    retentionDays,
    busyId,
    reload,
    cancel,
    clearHistory,
  };
}
