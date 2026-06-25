/**
 * "Schedule" panel — set the current message to post later, once or on a
 * recurring wall-clock cadence, then manage existing schedules.
 *
 * Unlike Send, scheduling can't be browser-only: to fire while the tab is
 * closed the proxy must hold the webhook URL + payload until run time (sealed at
 * rest, auto-deleted when the series ends — see `server/src/schedule.rs`). The
 * panel makes that tradeoff explicit up front.
 *
 * It reuses the Send destination UX (the channel-first `GuildWebhookPicker`,
 * this-browser `WebhookRecents`, and a manual URL field) and the same validation
 * gate, then adds a recurrence builder (one-time / daily / weekly / monthly) with
 * a timezone, optional end condition, and an optional title. Messages with
 * uploaded files can't be scheduled — the bytes never leave the browser — so
 * those are blocked with a clear note.
 *
 * Recurring rules are computed server-side with the IANA timezone (DST-correct),
 * so the panel sends the rule + tz, not a precomputed instant. A one-time post
 * sends an absolute instant derived from the picked wall-clock time.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { useAuthStore } from "@/core/auth/authStore";
import { useGuildStore } from "@/core/guild/guildStore";
import { validateMessage } from "@/core/schema/validation";
import { encodeJson } from "@/core/serialization";
import { collectMessagePlaceholders, substituteMessage } from "@/core/plugins/placeholders";
import { getPlugins } from "@/core/plugins/registry";
import {
  loadHistory,
  parseWebhookUrl,
  rememberWebhook,
  useCanManageGuildWebhooks,
  type WebhookHistoryEntry,
} from "@/core/webhook";
import { type GuildWebhook } from "@/core/guild/api";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { TextInput } from "@/ui/TextInput";
import { LockIcon } from "@/ui/Icon";
import { pushToast } from "@/ui/Toast";
import { cn } from "@/lib/cn";
import {
  createSchedule,
  isScheduleConfigured,
  type CreateScheduleInput,
} from "@/core/schedule/api";
import { rememberSchedule } from "@/core/schedule/localStore";
import {
  allTimezones,
  browserTimezone,
  formatInstant,
  formatRecurrence,
  WEEKDAY_LABELS,
  weekdayLong,
  type Recurrence,
} from "@/core/schedule/recurrence";
import { WebhookRecents } from "./WebhookRecents";
import { GuildWebhookPicker } from "./GuildWebhookPicker";
import { ScheduledList } from "./ScheduledList";
import { Callout } from "./Callout";
import styles from "./SchedulePanel.module.css";

type Mode = "once" | "daily" | "weekly" | "monthly";
type EndMode = "never" | "on" | "after";

/** Default the one-time picker to the next whole hour, in local wall-clock. */
function defaultOnceLocal(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setMinutes(0, 0, 0);
  // datetime-local wants "YYYY-MM-DDTHH:MM" in local time.
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseTimeOfDay(hhmm: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

export function SchedulePanel({ onCloseDialog }: { onCloseDialog?: () => void }) {
  const message = useMessageStore((s) => s.message);

  // ── Destination ────────────────────────────────────────────────────────
  const [url, setUrl] = useState("");
  const [revealUrl, setRevealUrl] = useState(false);
  const [history, setHistory] = useState<WebhookHistoryEntry[]>(() => loadHistory());
  const urlInputRef = useRef<HTMLInputElement>(null);
  const parsedUrl = useMemo(() => parseWebhookUrl(url), [url]);
  const urlInvalid = url.trim().length > 0 && !parsedUrl;

  const authStatus = useAuthStore((s) => s.status);
  const authGuilds = useAuthStore((s) => s.guilds);
  const login = useAuthStore((s) => s.login);
  const connectedData = useGuildStore((s) => s.data);
  const pickerActive = useCanManageGuildWebhooks();

  // Best-known destination names for the picked webhook, for the dest label +
  // {server}/{channel} placeholder substitution at schedule time.
  const destMeta = useMemo(() => {
    if (!parsedUrl) return undefined;
    const e = history.find((h) => h.id === parsedUrl.id);
    return e
      ? {
          guildId: e.guildId,
          channelId: e.channelId,
          guildName: e.guildName,
          channelName: e.channelName,
        }
      : undefined;
  }, [parsedUrl, history]);

  // ── Schedule shape ─────────────────────────────────────────────────────
  const [mode, setMode] = useState<Mode>("daily");
  const [onceLocal, setOnceLocal] = useState<string>(defaultOnceLocal);
  const [time, setTime] = useState("09:00");
  const [weekdays, setWeekdays] = useState<number[]>(() => [new Date().getDay()]);
  const [monthlyDay, setMonthlyDay] = useState<number>(() => Math.min(new Date().getDate(), 28));
  const timezones = useMemo(() => allTimezones(), []);
  const [tz, setTz] = useState<string>(() => browserTimezone());

  const [endMode, setEndMode] = useState<EndMode>("never");
  const [endDate, setEndDate] = useState("");
  const [maxRuns, setMaxRuns] = useState(10);

  const [threadId, setThreadId] = useState("");
  const [title, setTitle] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // ── Gates ──────────────────────────────────────────────────────────────
  const validation = useMemo(() => validateMessage(message), [message]);
  const blockingIssues = validation.issues.filter((i) => i.severity === "error");
  // Local uploads (session:// blobs) can't be carried to the server — the bytes
  // live only in this browser. Block those rather than schedule a broken post.
  const hasUploads = useMemo(() => JSON.stringify(message).includes("session://"), [message]);

  const recurring = mode !== "once";

  // A human description of when this posts, for the preview line.
  const preview = useMemo(() => {
    const tod = parseTimeOfDay(time);
    if (mode === "once") {
      const ms = Date.parse(onceLocal);
      if (Number.isNaN(ms)) return null;
      return `Posts once — ${formatInstant(Math.floor(ms / 1000), browserTimezone())}`;
    }
    if (!tod) return null;
    let rec: Recurrence;
    if (mode === "daily") rec = { kind: "daily", time: tod };
    else if (mode === "weekly") rec = { kind: "weekly", time: tod, weekdays };
    else rec = { kind: "monthly", time: tod, day: monthlyDay };
    return `Posts ${formatRecurrence(rec).toLowerCase()} · ${tz}`;
  }, [mode, onceLocal, time, weekdays, monthlyDay, tz]);

  // A verified result only describes the URL it was fetched for; reset on edit.
  useEffect(() => setError(null), [url, mode, time, onceLocal, weekdays, monthlyDay, tz, endMode]);

  const toggleWeekday = (d: number) => {
    setWeekdays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort()));
  };

  const handlePickGuildWebhook = (w: GuildWebhook) => {
    const parsed = parseWebhookUrl(w.url ?? "");
    if (!parsed) return;
    const channelName = w.channel_id ? connectedData?.channelById[w.channel_id]?.name : undefined;
    const guildName = w.guild_id ? authGuilds.find((g) => g.id === w.guild_id)?.name : undefined;
    rememberWebhook(parsed.url, {
      name: w.name ?? undefined,
      ownerKind: w.application_id ? "bot" : "user",
      applicationId: w.application_id ?? undefined,
      avatar: w.avatar,
      channelId: w.channel_id ?? undefined,
      guildId: w.guild_id ?? undefined,
      channelName,
      guildName,
    });
    setUrl(parsed.url);
    setHistory(loadHistory());
    setError(null);
  };

  const handleSubmit = async () => {
    setError(null);
    setSuccess(null);
    if (!parsedUrl) {
      setError("Choose or paste a Discord webhook URL.");
      return;
    }
    if (hasUploads) {
      setError("This message has uploaded files, which can't be scheduled. Use image/media URLs instead.");
      return;
    }
    if (blockingIssues.length > 0) {
      setError(
        `${blockingIssues.length} validation error${blockingIssues.length === 1 ? "" : "s"} — fix them before scheduling.`,
      );
      return;
    }
    if (threadId.trim() && !/^\d{15,25}$/.test(threadId.trim())) {
      setError("That thread ID looks wrong.");
      return;
    }

    // Build the recurrence + timing.
    let recurrence: Recurrence;
    let startAt: number | undefined;
    if (mode === "once") {
      const ms = Date.parse(onceLocal);
      if (Number.isNaN(ms)) {
        setError("Pick a date and time.");
        return;
      }
      if (ms < Date.now() - 60_000) {
        setError("That time is in the past.");
        return;
      }
      recurrence = { kind: "once" };
      startAt = Math.floor(ms / 1000);
    } else {
      const tod = parseTimeOfDay(time);
      if (!tod) {
        setError("Pick a valid time of day.");
        return;
      }
      if (mode === "daily") recurrence = { kind: "daily", time: tod };
      else if (mode === "weekly") {
        if (weekdays.length === 0) {
          setError("Pick at least one weekday.");
          return;
        }
        recurrence = { kind: "weekly", time: tod, weekdays };
      } else {
        recurrence = { kind: "monthly", time: tod, day: monthlyDay };
      }
    }

    // End condition (recurring only).
    let endAt: number | undefined;
    let maxRunsOut: number | undefined;
    if (recurring && endMode === "on") {
      const ms = Date.parse(`${endDate}T23:59`);
      if (Number.isNaN(ms)) {
        setError("Pick an end date.");
        return;
      }
      endAt = Math.floor(ms / 1000);
    } else if (recurring && endMode === "after") {
      if (maxRuns < 1) {
        setError("Run count must be at least 1.");
        return;
      }
      maxRunsOut = maxRuns;
    }

    // The postable wire body: substitute core placeholders from the chosen
    // destination, then encode (flags included, session refs stripped) — the
    // same path the JSON export uses, so what's stored is what Discord accepts.
    const outgoing = substituteMessage(
      message,
      collectMessagePlaceholders(message, getPlugins(), {
        serverId: destMeta?.guildId,
        serverName: destMeta?.guildName,
        channelId: destMeta?.channelId,
        channelName: destMeta?.channelName,
      }),
    );
    let payload: unknown;
    try {
      payload = JSON.parse(encodeJson(outgoing));
    } catch {
      setError("Couldn't encode the message.");
      return;
    }

    const destLabel =
      destMeta?.channelName && destMeta.guildName
        ? `#${destMeta.channelName} · ${destMeta.guildName}`
        : (destMeta?.guildName ?? undefined);

    const input: CreateScheduleInput = {
      webhook_url: parsedUrl.url,
      thread_id: threadId.trim() || undefined,
      payload,
      tz: mode === "once" ? browserTimezone() : tz,
      recurrence,
      start_at: startAt,
      end_at: endAt,
      max_runs: maxRunsOut,
      title: title.trim() || undefined,
      dest_label: destLabel,
    };

    setBusy(true);
    const res = await createSchedule(input);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    rememberSchedule({
      id: res.id,
      manageToken: res.manage_token,
      title: title.trim() || undefined,
      webhookId: parsedUrl.id,
      createdAt: Date.now(),
    });
    rememberWebhook(parsedUrl.url);
    setHistory(loadHistory());
    setSuccess(`Scheduled. Next post: ${formatInstant(res.next_run_at, input.tz)}.`);
    setReloadToken((t) => t + 1);
    pushToast("Post scheduled.", "success");
  };

  if (!isScheduleConfigured()) {
    return <p className={styles.lead}>Scheduling isn't available on this deployment.</p>;
  }

  return (
    <>
      <p className={styles.lead}>
        Post this message later — once, or on a repeating schedule.{" "}
        <strong>This uploads the message and webhook to our server</strong> (encrypted), where it
        stays only until the schedule finishes, then it's deleted. Unlike Send, the contents leave
        your browser — skip it for the most sensitive announcements.
      </p>

      {hasUploads ? (
        <Callout tone="warning" role="note">
          This message includes <strong>uploaded files</strong>, which can't be scheduled — the file
          data only lives in your browser. Swap them for image/media URLs to schedule it.
        </Callout>
      ) : null}
      {blockingIssues.length > 0 ? (
        <Callout tone="warning" role="note">
          Fix the {blockingIssues.length} validation error{blockingIssues.length === 1 ? "" : "s"} in
          the editor before scheduling.
        </Callout>
      ) : null}

      {/* ── Destination ── */}
      <p className={styles.sectionTitle}>Where to post</p>
      {pickerActive ? (
        <GuildWebhookPicker mode="send" activeId={parsedUrl?.id ?? null} onPick={handlePickGuildWebhook} />
      ) : null}
      <WebhookRecents
        history={history}
        activeId={parsedUrl?.id ?? null}
        onUse={(entry) => setUrl(entry.url)}
        onChange={() => setHistory(loadHistory())}
      />
      <Field
        label="Webhook URL"
        error={urlInvalid ? "Not a valid Discord webhook URL." : undefined}
      >
        {(id) => (
          <div className={styles.row}>
            <TextInput
              ref={urlInputRef}
              id={id}
              masked={!revealUrl}
              spellCheck={false}
              value={url}
              onChange={(e) => setUrl(e.currentTarget.value)}
              invalid={urlInvalid}
              placeholder="https://discord.com/api/webhooks/…"
            />
            <button
              type="button"
              className={styles.smallBtn}
              style={{ flex: "0 0 auto" }}
              onClick={() => setRevealUrl((v) => !v)}
              aria-pressed={revealUrl}
            >
              {revealUrl ? "Hide" : "Show"}
            </button>
          </div>
        )}
      </Field>

      {/* ── When ── */}
      <p className={styles.sectionTitle}>When to post</p>
      <div className={styles.segmented} role="radiogroup" aria-label="Schedule type">
        {(["once", "daily", "weekly", "monthly"] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            className={cn(styles.segment, mode === m && styles.segmentActive)}
            onClick={() => setMode(m)}
          >
            {m === "once" ? "One time" : m[0]!.toUpperCase() + m.slice(1)}
          </button>
        ))}
      </div>

      {mode === "once" ? (
        <Field label="Date & time (your local time)">
          {(id) => (
            <input
              id={id}
              type="datetime-local"
              className={styles.tzSelect}
              value={onceLocal}
              onChange={(e) => setOnceLocal(e.currentTarget.value)}
            />
          )}
        </Field>
      ) : (
        <>
          <div className={styles.row}>
            <Field label="Time of day">
              {(id) => (
                <input
                  id={id}
                  type="time"
                  className={styles.tzSelect}
                  value={time}
                  onChange={(e) => setTime(e.currentTarget.value)}
                />
              )}
            </Field>
            <Field label="Timezone">
              {(id) => (
                <select
                  id={id}
                  className={styles.tzSelect}
                  value={tz}
                  onChange={(e) => setTz(e.currentTarget.value)}
                >
                  {timezones.map((z) => (
                    <option key={z} value={z}>
                      {z}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>

          {mode === "weekly" ? (
            <Field label="Repeat on">
              {() => (
                <div className={styles.weekdays}>
                  {WEEKDAY_LABELS.map((label, d) => (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={weekdays.includes(d)}
                      aria-label={weekdayLong(d)}
                      className={cn(styles.weekday, weekdays.includes(d) && styles.weekdayOn)}
                      onClick={() => toggleWeekday(d)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </Field>
          ) : null}

          {mode === "monthly" ? (
            <Field label="Day of month" hint="The 31st falls back to the last day in shorter months.">
              {(id) => (
                <select
                  id={id}
                  className={styles.daySelect}
                  value={monthlyDay}
                  onChange={(e) => setMonthlyDay(Number(e.currentTarget.value))}
                >
                  {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ) : null}

          {/* End condition (recurring only). */}
          <Field label="Ends">
            {() => (
              <div className={styles.endRow}>
                <select
                  className={styles.daySelect}
                  style={{ width: "auto" }}
                  value={endMode}
                  onChange={(e) => setEndMode(e.currentTarget.value as EndMode)}
                >
                  <option value="never">Never</option>
                  <option value="on">On date</option>
                  <option value="after">After N posts</option>
                </select>
                {endMode === "on" ? (
                  <input
                    type="date"
                    className={styles.daySelect}
                    style={{ width: "auto" }}
                    value={endDate}
                    onChange={(e) => setEndDate(e.currentTarget.value)}
                  />
                ) : null}
                {endMode === "after" ? (
                  <input
                    type="number"
                    min={1}
                    className={styles.daySelect}
                    style={{ width: "90px" }}
                    value={maxRuns}
                    onChange={(e) => setMaxRuns(Number(e.currentTarget.value))}
                  />
                ) : null}
              </div>
            )}
          </Field>
        </>
      )}

      <Field label="Thread ID (optional)" hint="Only if the message should post into a thread.">
        {(id) => (
          <TextInput
            id={id}
            value={threadId}
            onChange={(e) => setThreadId(e.currentTarget.value.replace(/[^\d]/g, ""))}
            placeholder="e.g. 1185234567890123456"
            inputMode="numeric"
          />
        )}
      </Field>
      <Field label="Label (optional)" hint="Shown in your scheduled-posts list below.">
        {(id) => (
          <TextInput
            id={id}
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
            placeholder="e.g. Weekly standup reminder"
          />
        )}
      </Field>

      {preview ? <div className={styles.nextPreview}>{preview}</div> : null}
      {error ? <div className={styles.error}>{error}</div> : null}
      {success ? <div className={styles.success}>{success}</div> : null}

      <div className={styles.row} style={{ justifyContent: "flex-start" }}>
        <Button
          variant="primary"
          onClick={handleSubmit}
          disabled={busy || !parsedUrl || hasUploads || blockingIssues.length > 0}
        >
          {busy ? "Scheduling…" : "Schedule post"}
        </Button>
      </div>

      {/* ── Existing schedules ── */}
      <p className={styles.sectionTitle} style={{ marginTop: 8 }}>
        Your scheduled posts
        {authStatus !== "authed" ? (
          <>
            {" — "}
            <button type="button" className={styles.smallBtn} style={{ padding: "2px 8px" }} onClick={() => login()}>
              Sign in
            </button>{" "}
            to sync across devices
          </>
        ) : null}
      </p>
      <ScheduledList reloadToken={reloadToken} onLoaded={onCloseDialog} />

      <p className={styles.lead} style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <LockIcon size={13} />
        Stored encrypted; only someone with this browser's manage token (or your signed-in account)
        can edit or cancel a schedule.
      </p>
    </>
  );
}
