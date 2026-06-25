/**
 * "Schedule for later" — a compact card folded into the bottom of the Send
 * panel. It reuses the webhook the user already chose above, so scheduling is
 * just "pick a time, hit Schedule" with no second destination to set up.
 *
 * One-time only by design: the message posts once at the chosen instant, then
 * the schedule is done (the proxy supports recurring rules, but the UI keeps it
 * simple). Like Send, scheduling needs no account — the schedule is owned by a
 * manage token kept in this browser; signing in also syncs it across devices.
 *
 * The post is stored on the proxy (sealed at rest) until it fires, so messages
 * with uploaded files can't be scheduled (the bytes never leave the browser) and
 * are blocked with a clear note — same gate as elsewhere.
 */

import { useMemo, useState } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { validateMessage } from "@/core/schema/validation";
import { encodeJson } from "@/core/serialization";
import { collectMessagePlaceholders, substituteMessage } from "@/core/plugins/placeholders";
import { getPlugins } from "@/core/plugins/registry";
import { rememberWebhook } from "@/core/webhook";
import { Button } from "@/ui/Button";
import { ClockIcon } from "@/ui/Icon";
import { pushToast } from "@/ui/Toast";
import { createSchedule } from "@/core/schedule/api";
import { rememberSchedule } from "@/core/schedule/localStore";
import { browserTimezone, formatInstant } from "@/core/schedule/recurrence";
import { ScheduledList } from "./ScheduledList";
import styles from "./ScheduleSection.module.css";

/** Default the picker to the next whole hour, in local wall-clock. */
function defaultDateTime(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setMinutes(0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ScheduleSection({
  webhookUrl,
  guildId,
  channelId,
  guildName,
  channelName,
  onLoaded,
}: {
  /** The resolved webhook URL chosen in the Send panel, or null if none yet. */
  webhookUrl: string | null;
  guildId?: string;
  channelId?: string;
  guildName?: string;
  channelName?: string;
  /** Closes the dialog after a scheduled message is loaded back into the editor. */
  onLoaded?: () => void;
}) {
  const message = useMessageStore((s) => s.message);
  const [dt, setDt] = useState<string>(defaultDateTime);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [count, setCount] = useState(0);

  const validation = useMemo(() => validateMessage(message), [message]);
  const blockingIssues = validation.issues.filter((i) => i.severity === "error");
  // Uploaded files (session:// blobs) live only in this browser, so they can't
  // be carried to the server for a later post.
  const hasUploads = useMemo(() => JSON.stringify(message).includes("session://"), [message]);

  // Why the Schedule button is unavailable, if it is — shown as a subtle hint.
  const blockedReason = !webhookUrl
    ? "Choose a webhook above first."
    : hasUploads
      ? "Uploaded files can't be scheduled — use image/media URLs instead."
      : blockingIssues.length > 0
        ? "Fix the validation errors above before scheduling."
        : null;

  const handleSchedule = async () => {
    setError(null);
    setSuccess(null);
    if (!webhookUrl || blockedReason) return;
    const ms = Date.parse(dt);
    if (Number.isNaN(ms)) {
      setError("Pick a date and time.");
      return;
    }
    if (ms < Date.now() - 60_000) {
      setError("That time is in the past — pick a future time.");
      return;
    }
    const startAt = Math.floor(ms / 1000);

    // The postable wire body: substitute {server}/{channel} from the chosen
    // destination, then encode (flags included, session refs stripped).
    const outgoing = substituteMessage(
      message,
      collectMessagePlaceholders(message, getPlugins(), {
        serverId: guildId,
        serverName: guildName,
        channelId,
        channelName,
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
      channelName && guildName ? `#${channelName} · ${guildName}` : (guildName ?? undefined);

    setBusy(true);
    const res = await createSchedule({
      webhook_url: webhookUrl,
      payload,
      tz: browserTimezone(),
      recurrence: { kind: "once" },
      start_at: startAt,
      dest_label: destLabel,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    rememberSchedule({
      id: res.id,
      manageToken: res.manage_token,
      webhookId: undefined,
      createdAt: Date.now(),
    });
    rememberWebhook(webhookUrl);
    setSuccess(`Scheduled for ${formatInstant(res.next_run_at, browserTimezone())}.`);
    setReloadToken((t) => t + 1);
    pushToast("Post scheduled.", "success");
  };

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <ClockIcon size={15} />
        <span className={styles.title}>Schedule for later</span>
        {count > 0 ? <span className={styles.count}>{count}</span> : null}
      </div>
      <p className={styles.lead}>
        Post this message automatically at a future time. It's stored on our server (encrypted) only
        until it posts, then deleted.
      </p>

      <div className={styles.row}>
        <input
          type="datetime-local"
          className={styles.dtInput}
          value={dt}
          onChange={(e) => {
            setDt(e.currentTarget.value);
            setError(null);
            setSuccess(null);
          }}
          aria-label="Post date and time"
        />
        <Button variant="secondary" onClick={handleSchedule} disabled={busy || blockedReason != null}>
          {busy ? "Scheduling…" : "Schedule"}
        </Button>
      </div>

      {blockedReason ? <div className={styles.hint}>{blockedReason}</div> : null}
      {error ? <div className={styles.error}>{error}</div> : null}
      {success ? <div className={styles.success}>{success}</div> : null}

      <ScheduledList reloadToken={reloadToken} onLoaded={onLoaded} onCount={setCount} />
    </div>
  );
}
