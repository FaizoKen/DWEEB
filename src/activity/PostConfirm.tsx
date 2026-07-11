/**
 * Pre-post confirmation dialog — the Activity's pared-down cousin of the web
 * app's `SendConfirm`.
 *
 * Posting fires a real message (and its pings) into a channel, so the bar pops
 * this summary before the actual POST/PATCH runs. It restates the two things a
 * user most often gets wrong:
 *   - *where* the message lands — which server and channel; and
 *   - *who gets pinged* — computed from the message's mention tokens crossed
 *     with its `allowed_mentions` policy, so an `@everyone` that will actually
 *     ring the whole channel is impossible to miss.
 *
 * Unlike the web confirm there's no webhook/ownership/routing/permanence to
 * decide: the proxy posts through a DWEEB-owned webhook it resolves server-side
 * (see `ChannelPicker`), so those rows simply don't exist here. The preview
 * also always resolves against the same server we post to, so the web app's
 * "preview names may be placeholders" caveat can't arise either.
 *
 * A brand-new post also chooses *when*: now (the default) or a one-time
 * scheduled post at a picked instant — the proxy then holds the message
 * (sealed) and posts it later through the same DWEEB webhook, no browser
 * needed. Existing schedules are managed in the Message directory's
 * Scheduled tab (see `ActivityGallery`).
 *
 * Presentational: it owns no post logic. Confirming hands back to the bar,
 * which runs `publish()` / `update()` / `schedule()` and, on success, opens
 * `PostSuccess` (or toasts the fire time for a schedule).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { useActivityStore } from "@/core/activity/activityStore";
import { useRoleInfo } from "@/core/guild/guildStore";
import { summarizePings, type PingSummary } from "@/core/schema/mentions";
import { inspectCapabilities } from "@/core/schema/capability";
import { LIMITS } from "@/core/schema/limits";
import type { PickerGuild, PermanentSlots } from "@/core/guild/api";
import {
  fetchActivityIdentities,
  fetchActivityPermanentSlots,
  startConnectCustomBot,
  type ActivityIdentity,
} from "@/core/activity/api";
import { openExternalLink } from "@/core/activity/sdk";
import { Modal } from "@/ui/Modal";
import { Button } from "@/ui/Button";
import { Switch } from "@/ui/Switch";
import { pushToast } from "@/ui/Toast";
import { ClockIcon, PlusIcon, SendIcon, RefreshIcon } from "@/ui/Icon";
import { ServerGlyph } from "./GuildPicker";
import styles from "./PostConfirm.module.css";

export interface PostConfirmProps {
  open: boolean;
  /** "new" POSTs a brand-new message; "update" PATCHes the linked one. */
  mode: "new" | "update";
  /**
   * The "New" toolbar button posts a *separate* copy alongside the already-
   * linked message (mode is still "new"). Flag it so the wording is honest —
   * "Post a new copy?" rather than implying this is the first post.
   */
  newCopy?: boolean;
  /** Destination server, for the icon + name. Null until its meta is known. */
  guild?: PickerGuild | null;
  /** Destination guild id — needed to read the never-expire slot state. */
  guildId?: string | null;
  /** Resolved destination channel name (without the leading `#`), when known. */
  channelName?: string;
  /** The destination channel's Discord `type`, when known. A forum (15) or
   *  media (16) destination starts a NEW post there, so the confirm collects a
   *  required post title (the draft's `thread_name`) for a brand-new post. */
  channelType?: number;
  /** True while the confirmed post is in flight — drives the button spinner. */
  busy?: boolean;
  /** Confirm the post. `makePermanent` carries the "Never expire" choice (always
   *  false unless the toggle was shown and switched on); `postAs` carries the
   *  "Post as" choice — a connected custom bot's application id, or null for
   *  DWEEB (always null unless the picker was shown). */
  onConfirm: (makePermanent: boolean, postAs: string | null) => void;
  /** Confirm a SCHEDULED post instead (the "When → Schedule" choice, brand-new
   *  posts only): store the message server-side and post it at `at` (unix
   *  seconds). Scheduled posts always go out as DWEEB, so there's no `postAs`. */
  onSchedule: (makePermanent: boolean, at: number) => void;
  onCancel: () => void;
  /** Hand off to the full web app — used by the "Manage on web" action when every
   *  never-expire slot is taken (managing/freeing slots lives on the web). */
  onManageOnWeb?: () => void;
  /** Open this guild's custom-bot configuration in the full web app. */
  onManageCustomBots?: () => void;
}

/** Format a Date as a `datetime-local` value (local wall-clock, minute precision). */
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Default the schedule picker to the next whole hour, in local wall-clock —
 *  mirrors the web app's Send panel. */
function defaultScheduleAt(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setMinutes(0, 0, 0);
  return toLocalInputValue(d);
}

/** Render a short, readable list of user-mention chips with a "+N more" tail. */
function UserChips({ ids, max = 6 }: { ids: string[]; max?: number }) {
  const shown = ids.slice(0, max);
  const rest = ids.length - shown.length;
  return (
    <span className={styles.chips}>
      {shown.map((id) => (
        <code key={id} className={styles.chip}>
          @{id}
        </code>
      ))}
      {rest > 0 ? <span className={styles.chipMore}>+{rest} more</span> : null}
    </span>
  );
}

/**
 * A single role chip. Resolves `<@&id>` to `@role-name` against the connected
 * server (which, in the Activity, is always the destination server); falls back
 * to the raw `@&id` snowflake when the role is unknown.
 */
function RoleChip({ id }: { id: string }) {
  const role = useRoleInfo(id);
  return <code className={styles.chip}>{role ? `@${role.name}` : `@&${id}`}</code>;
}

function RoleChips({ ids, max = 6 }: { ids: string[]; max?: number }) {
  const shown = ids.slice(0, max);
  const rest = ids.length - shown.length;
  return (
    <span className={styles.chips}>
      {shown.map((id) => (
        <RoleChip key={id} id={id} />
      ))}
      {rest > 0 ? <span className={styles.chipMore}>+{rest} more</span> : null}
    </span>
  );
}

/** Who the message will actually ping, after `allowed_mentions` — the headline
 *  safety check before a post. Mirrors the web confirm's ping summary. */
function PingSummaryView({ pings }: { pings: PingSummary }) {
  const { everyone, roleIds, userIds, suppressed } = pings;
  const hasSuppressed =
    suppressed.everyone || suppressed.roleIds.length > 0 || suppressed.userIds.length > 0;

  if (!pings.willPing) {
    return (
      <div className={styles.pingCalm} role="note">
        <strong>No one will be pinged.</strong>
        <p className={styles.pingDetail}>
          {pings.hasMentions
            ? "Mentions are written in the text, but allowed-mentions settings stop them resolving."
            : "This message contains no @everyone, role, or user mentions."}
        </p>
      </div>
    );
  }

  return (
    <div className={styles.pingAlert} role="alert">
      <strong>This will ping:</strong>
      <ul className={styles.pingList}>
        {everyone ? (
          <li>
            <span className={styles.pingEveryone}>@everyone / @here</span> — the whole channel.
          </li>
        ) : null}
        {roleIds.length > 0 ? (
          <li>
            {roleIds.length} role{roleIds.length === 1 ? "" : "s"}: <RoleChips ids={roleIds} />
          </li>
        ) : null}
        {userIds.length > 0 ? (
          <li>
            {userIds.length} user{userIds.length === 1 ? "" : "s"}: <UserChips ids={userIds} />
          </li>
        ) : null}
      </ul>
      {hasSuppressed ? (
        <p className={styles.pingDetail}>
          Other mentions in the text won’t ping (filtered by allowed-mentions).
        </p>
      ) : null}
      {pings.suppressNotifications ? (
        <p className={styles.pingDetail}>
          Silent send is on — recipients are mentioned but get no notification.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The "Never expire" control for a message with interactive components. By
 * default the post's buttons & selects stop working after the deployment TTL;
 * claiming one of the server's never-expire slots keeps them alive. Mirrors the
 * web app's PermanentOptIn, minus the update-target/already-permanent cases (the
 * Activity only offers it on a brand-new post). When every slot is taken the
 * switch gives way to a "Manage on web" hand-off — freeing slots lives there.
 */
function PermanentOptIn({
  slots,
  checked,
  onChange,
  busy,
  onManageOnWeb,
}: {
  slots: PermanentSlots;
  checked: boolean;
  onChange: (checked: boolean) => void;
  busy: boolean;
  onManageOnWeb?: () => void;
}) {
  const slotsFull = slots.used >= slots.cap;
  const sub = slotsFull
    ? `All ${slots.cap} never-expire slots are in use — free one or upgrade for more on the web`
    : `Buttons & selects keep working · ${slots.used}/${slots.cap} slots used`;

  return (
    <div className={styles.permanentBox}>
      <div className={styles.permanentRow}>
        <span className={styles.permanentCopy} id="post-confirm-permanent">
          <span className={styles.permanentTitle}>Never expire</span>
          <span className={styles.permanentSub}>{sub}</span>
        </span>
        {!slotsFull ? (
          <Switch
            aria-labelledby="post-confirm-permanent"
            checked={checked}
            disabled={busy}
            onChange={(e) => onChange(e.currentTarget.checked)}
          />
        ) : null}
      </div>
      {slotsFull && onManageOnWeb ? (
        <div className={styles.permanentAction}>
          <Button size="sm" variant="secondary" disabled={busy} onClick={onManageOnWeb}>
            Manage on web ↗
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function PostConfirm({
  open,
  mode,
  newCopy = false,
  guild,
  guildId,
  channelName,
  channelType,
  busy = false,
  onConfirm,
  onSchedule,
  onCancel,
  onManageOnWeb,
  onManageCustomBots,
}: PostConfirmProps) {
  const message = useMessageStore((s) => s.message);
  const setThreadName = useMessageStore((s) => s.setThreadName);
  const pings = useMemo(() => summarizePings(message), [message]);

  // A forum/media destination can only receive a NEW post (a titled thread),
  // so a brand-new post there needs a title. The field edits the shared
  // draft's `thread_name` directly — the same field Message options → Forum
  // sets on the web — so it's collab-synced and rides the wire payload the
  // proxy forwards (and re-guards). An update targets the existing post, so
  // no title is asked for there.
  const forumDest = channelType === 15 || channelType === 16;
  const needsTitle = mode === "new" && forumDest;
  const postTitle = message.thread_name ?? "";
  const [titleError, setTitleError] = useState<string | null>(null);
  useEffect(() => {
    if (open) setTitleError(null);
  }, [open]);
  /** Gate a confirm/schedule on the forum post title being present. */
  const guardTitle = (): boolean => {
    if (!needsTitle || postTitle.trim().length > 0) return true;
    setTitleError("Give the new forum post a title first.");
    return false;
  };

  // Send now vs schedule for later — only a brand-new post offers the choice
  // (an update edits a live message; "later" has no meaning there). While
  // "Schedule" is picked the primary button converts to "Schedule post" and the
  // create runs through `onSchedule` instead of `onConfirm`. Fresh per open.
  const offersSchedule = mode === "new";
  const [when, setWhen] = useState<"now" | "later">("now");
  const [scheduleAt, setScheduleAt] = useState<string>(defaultScheduleAt);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setWhen("now");
    setScheduleAt(defaultScheduleAt());
    setScheduleError(null);
  }, [open]);
  const scheduling = offersSchedule && when === "later";

  // Whether the message carries interactive components — the only case where
  // expiry (and so the "Never expire" toggle) is relevant. Same signal the web
  // app keys its permanence UI on.
  const hasInteractive = useMemo(
    () => inspectCapabilities(message).some((c) => c.kind === "app_webhook"),
    [message],
  );

  // Never-expire slot state, fetched when the confirm opens for a brand-new post
  // of an interactive message. Null until it resolves; the toggle only renders on
  // a successful fetch with expiry actually configured. `makePermanent` is the
  // switch — defaulted ON when a slot is free so interactive posts keep working
  // unless the user opts out (matching the web app).
  const offersPermanent = open && mode === "new" && hasInteractive && !!guildId;
  const [slots, setSlots] = useState<PermanentSlots | null>(null);
  const [makePermanent, setMakePermanent] = useState(false);
  useEffect(() => {
    if (!offersPermanent || !guildId) return;
    setSlots(null);
    setMakePermanent(false);
    const ac = new AbortController();
    fetchActivityPermanentSlots(guildId, ac.signal)
      .then((s) => {
        setSlots(s);
        // On when expiry is configured here and a slot is free to claim; a full
        // server (or expiry off) leaves it off — the user can't claim from here.
        setMakePermanent(s.ttl_days !== null && s.used < s.cap);
      })
      .catch(() => {
        // 501 (feature off), 403, network, abort — just leave the toggle hidden;
        // the post proceeds as an ordinary (expiring) message.
      });
    return () => ac.abort();
  }, [offersPermanent, guildId]);

  // Show the toggle only once slots resolved and this deployment actually expires
  // components (ttl_days set) — otherwise there's nothing to keep alive.
  const showPermanent = offersPermanent && slots != null && slots.ttl_days !== null;

  // "Post as" — DWEEB or one of the server's registered custom bots. Only a
  // brand-new post chooses an identity (an update rides whatever authored the
  // message). The row always renders for a destination guild: even a server
  // with no custom bots needs its DWEEB choice plus the add/manage shortcut.
  // Like the web app's Send panel, a ready custom bot is pre-selected until the
  // user picks; a fetch failure simply leaves DWEEB as the only identity while
  // the web shortcut remains available.
  const offersIdentity = open && mode === "new" && !!guildId;
  const [identities, setIdentities] = useState<ActivityIdentity[] | null>(null);
  const [postAs, setPostAs] = useState<string | null>(null);
  const identityTouched = useRef(false);
  // After the + opens web settings, re-read when the user returns so a newly
  // registered bot appears without closing and reopening this dialog.
  const refreshAfterManage = useRef(false);
  const manageRefreshInFlight = useRef(false);
  // The bot whose connect flow is out in the user's external browser — drives
  // the "waiting" pill until the server says it's ready.
  const [connecting, setConnecting] = useState<string | null>(null);
  // De-dupe: the bot we've already adopted this open, so the live push and the
  // focus fallback can't both select + toast for the same connect.
  const adoptedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!offersIdentity || !guildId) return;
    setIdentities(null);
    setPostAs(null);
    setConnecting(null);
    identityTouched.current = false;
    refreshAfterManage.current = false;
    manageRefreshInFlight.current = false;
    adoptedRef.current = null;
    const ac = new AbortController();
    fetchActivityIdentities(guildId, ac.signal)
      .then((ids) => {
        setIdentities(ids);
        if (!identityTouched.current) {
          const ready = ids.find((i) => i.kind === "custom" && i.ready);
          if (ready?.kind === "custom") setPostAs(ready.application_id);
        }
      })
      .catch(() => {
        // 501/403/network/abort — leave the row hidden; posting proceeds as DWEEB.
      });
    return () => ac.abort();
  }, [offersIdentity, guildId]);

  // Registering or removing bots happens in an external browser. Re-read the
  // identities when Discord becomes active again so the open dialog stays in
  // sync, without polling or disturbing the current Post-as choice.
  useEffect(() => {
    if (!offersIdentity || !guildId) return;
    let cancelled = false;

    const refresh = async () => {
      if (!refreshAfterManage.current || manageRefreshInFlight.current) return;
      manageRefreshInFlight.current = true;
      try {
        const ids = await fetchActivityIdentities(guildId);
        if (cancelled) return;
        setIdentities(ids);
        // If web settings removed the selected bot, fall back safely to DWEEB.
        setPostAs((current) =>
          current === null ||
          ids.some((i) => i.kind === "custom" && i.ready && i.application_id === current)
            ? current
            : null,
        );
      } catch {
        // A later focus/visibility return retries while this dialog stays open.
      } finally {
        manageRefreshInFlight.current = false;
      }
    };

    const onFocus = () => void refresh();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [offersIdentity, guildId]);

  // The instant path: the connect callback pushes a `bot_connected` frame down
  // the live collab socket (see activityStore), which lands even while the
  // Activity is backgrounded during the external-browser OAuth. Consume it —
  // mark the bot selectable for everyone in the room, and, for whoever kicked
  // off *this* connect, select it and confirm. No polling, no focus event, no
  // reopening the dialog.
  const connectedBot = useActivityStore((s) => s.connectedBot);
  const clearConnectedBot = useActivityStore((s) => s.clearConnectedBot);
  useEffect(() => {
    const appId = connectedBot;
    if (!appId) return;
    clearConnectedBot();
    // Flip the bot to ready in our list so its pill becomes selectable.
    setIdentities((prev) =>
      prev
        ? prev.map((i) =>
            i.kind === "custom" && i.application_id === appId ? { ...i, ready: true } : i,
          )
        : prev,
    );
    // Only the initiator (whose pill is mid-connect for this app) auto-selects.
    if (connecting === appId && adoptedRef.current !== appId) {
      adoptedRef.current = appId;
      setConnecting(null);
      setPostAs(appId);
      identityTouched.current = true;
      const bot = identities?.find((i) => i.kind === "custom" && i.application_id === appId);
      const name = bot?.kind === "custom" ? bot.name : "";
      pushToast(`${name || "Your bot"} is connected — posting as it now ✓`, "success");
    }
  }, [connectedBot, connecting, identities, clearConnectedBot]);

  // Fallback for the rare missed push (socket reconnecting at that instant):
  // while a connect is out, re-check on the user returning to the Activity.
  // Cheap and event-driven — no interval, since the push covers the timing and
  // a backgrounded iframe's timers are unreliable anyway.
  useEffect(() => {
    if (!connecting || !guildId) return;
    let cancelled = false;
    const check = async () => {
      try {
        const ids = await fetchActivityIdentities(guildId);
        if (cancelled) return;
        setIdentities(ids);
        const bot = ids.find((i) => i.kind === "custom" && i.application_id === connecting);
        if (bot?.kind === "custom" && bot.ready && adoptedRef.current !== connecting) {
          adoptedRef.current = connecting;
          setConnecting(null);
          setPostAs(bot.application_id);
          identityTouched.current = true;
          pushToast(`${bot.name || "Your bot"} is connected — posting as it now ✓`, "success");
        }
      } catch {
        /* transient — the push is the primary path */
      }
    };
    const onFocus = () => void check();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, [connecting, guildId]);

  // Start the one-time connect flow for a registered-but-unconnected bot: the
  // proxy mints the authorize URL and the host opens it externally (the
  // sandboxed iframe can't navigate to discord.com itself). The instance id
  // lets the callback push completion back over the room socket.
  const instanceId = useActivityStore((s) => s.context?.instanceId ?? "");
  const connectBot = async (applicationId: string) => {
    if (!guildId) return;
    try {
      const url = await startConnectCustomBot(guildId, applicationId, instanceId);
      try {
        await openExternalLink(url);
      } catch {
        // The web app / dev URL-override aren't sandboxed, so a plain open
        // works there when the SDK path can't.
        window.open(url, "_blank", "noopener");
      }
      setConnecting(applicationId);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Couldn't start connecting the bot.", "error");
    }
  };

  const customIdentities = (identities ?? []).filter(
    (i): i is Extract<ActivityIdentity, { kind: "custom" }> => i.kind === "custom",
  );
  // A scheduled post always goes out as DWEEB (a custom bot's roaming Activity
  // webhook could sit in another channel by fire time), so the "Post as" row
  // gives way to the schedule area's own note while "Schedule" is picked.
  const showIdentity = offersIdentity && !scheduling;

  const title =
    mode === "update"
      ? "Update this message?"
      : newCopy
        ? "Post a new copy?"
        : "Post this message?";
  const action =
    mode === "update"
      ? "Edit the message you posted here"
      : scheduling
        ? "Post a new message at the scheduled time"
        : newCopy
          ? "Post a separate new copy into the channel"
          : "Post a new message";
  const confirmLabel = scheduling
    ? busy
      ? "Scheduling…"
      : "Schedule post"
    : busy
      ? mode === "update"
        ? "Updating…"
        : "Posting…"
      : mode === "update"
        ? "Update message"
        : newCopy
          ? "Post copy"
          : "Post message";

  // Validate the picked time, then hand off. Runs from the primary button while
  // "Schedule" is picked; errors surface inline under the picker.
  const handleSchedule = () => {
    if (!guardTitle()) return;
    const at = Date.parse(scheduleAt);
    if (Number.isNaN(at)) {
      setScheduleError("Pick a date and time.");
      return;
    }
    if (at < Date.now() - 60_000) {
      setScheduleError("That time is in the past — pick a future time.");
      return;
    }
    onSchedule(showPermanent ? makePermanent : false, Math.floor(at / 1000));
  };

  return (
    <Modal
      open={open}
      onClose={onCancel}
      size="sm"
      title={title}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              if (scheduling) {
                handleSchedule();
                return;
              }
              if (!guardTitle()) return;
              onConfirm(showPermanent ? makePermanent : false, showIdentity ? postAs : null);
            }}
            disabled={busy}
            leadingIcon={
              busy ? (
                <span className={styles.spinner} aria-hidden="true" />
              ) : scheduling ? (
                <ClockIcon />
              ) : mode === "update" ? (
                <RefreshIcon />
              ) : (
                <SendIcon />
              )
            }
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt>Action</dt>
          <dd>{action}</dd>
        </div>
        {guild ? (
          <div className={styles.fact}>
            <dt>Server</dt>
            <dd>
              <span className={styles.server}>
                <ServerGlyph guild={guild} size={20} />
                <span className={styles.destName}>{guild.name}</span>
              </span>
            </dd>
          </div>
        ) : null}
        {channelName ? (
          <div className={styles.fact}>
            <dt>Channel</dt>
            <dd>
              <span className={styles.destName}>#{channelName}</span>
              {forumDest ? (
                <span className={styles.forumBadge}>
                  {channelType === 16 ? "Media channel" : "Forum"}
                </span>
              ) : null}
            </dd>
          </div>
        ) : null}
        {needsTitle ? (
          <div className={styles.fact}>
            <dt>Title</dt>
            <dd>
              <input
                type="text"
                className={styles.scheduleInput}
                value={postTitle}
                maxLength={LIMITS.THREAD_NAME}
                disabled={busy}
                placeholder="e.g. Release notes — v2.4"
                aria-label="Title for the new forum post"
                aria-invalid={titleError ? true : undefined}
                onChange={(e) => {
                  setThreadName(e.currentTarget.value || undefined);
                  setTitleError(null);
                }}
              />
              {titleError ? (
                <p className={styles.scheduleError} role="alert">
                  {titleError}
                </p>
              ) : null}
              <p className={styles.idHint}>
                Posting here starts a new {channelType === 16 ? "media" : "forum"} post with this
                title. Tags can be set under Message options → Forum post.
              </p>
            </dd>
          </div>
        ) : null}
        {offersSchedule ? (
          <div className={styles.fact}>
            <dt>When</dt>
            <dd>
              <div className={styles.idPills} role="group" aria-label="When to post">
                <button
                  type="button"
                  className={styles.idPill}
                  data-active={!scheduling ? "" : undefined}
                  disabled={busy}
                  onClick={() => {
                    setWhen("now");
                    setScheduleError(null);
                  }}
                >
                  Now
                </button>
                <button
                  type="button"
                  className={styles.idPill}
                  data-active={scheduling ? "" : undefined}
                  disabled={busy}
                  onClick={() => setWhen("later")}
                >
                  Schedule
                </button>
              </div>
              {scheduling ? (
                <div className={styles.scheduleArea}>
                  <input
                    type="datetime-local"
                    className={styles.scheduleInput}
                    value={scheduleAt}
                    min={toLocalInputValue(new Date())}
                    disabled={busy}
                    aria-label="Date and time to post"
                    onChange={(e) => {
                      setScheduleAt(e.currentTarget.value);
                      setScheduleError(null);
                    }}
                  />
                  {scheduleError ? (
                    <p className={styles.scheduleError} role="alert">
                      {scheduleError}
                    </p>
                  ) : null}
                  <p className={styles.idHint}>
                    Posts once at this time (your local time), as DWEEB. Manage or cancel it in the
                    Message directory's Scheduled tab.
                  </p>
                </div>
              ) : null}
            </dd>
          </div>
        ) : null}
        {showIdentity ? (
          <div className={styles.fact}>
            <dt>Post as</dt>
            <dd>
              <div className={styles.idPills} role="group" aria-label="Post as">
                <button
                  type="button"
                  className={styles.idPill}
                  data-active={postAs === null ? "" : undefined}
                  disabled={busy}
                  onClick={() => {
                    identityTouched.current = true;
                    setPostAs(null);
                  }}
                >
                  DWEEB
                </button>
                {customIdentities.map((bot) => {
                  const name = bot.name || "Custom bot";
                  if (bot.ready) {
                    return (
                      <button
                        key={bot.application_id}
                        type="button"
                        className={styles.idPill}
                        data-active={postAs === bot.application_id ? "" : undefined}
                        disabled={busy}
                        onClick={() => {
                          identityTouched.current = true;
                          setPostAs(bot.application_id);
                        }}
                      >
                        {name}
                      </button>
                    );
                  }
                  const waiting = connecting === bot.application_id;
                  return (
                    <button
                      key={bot.application_id}
                      type="button"
                      className={styles.idPillConnect}
                      disabled={busy || waiting || !bot.can_connect}
                      title={
                        bot.can_connect
                          ? `Connect ${name} once, then post as it in any channel`
                          : `Register ${name} again on the web with its client secret to enable this`
                      }
                      onClick={() => void connectBot(bot.application_id)}
                    >
                      {waiting ? `Connecting ${name}…` : `Connect ${name} ↗`}
                    </button>
                  );
                })}
                {onManageCustomBots ? (
                  <button
                    type="button"
                    className={styles.idPillAdd}
                    disabled={busy}
                    aria-label="Add or manage custom bots on the web"
                    title="Add or manage custom bots on the web"
                    onClick={() => {
                      refreshAfterManage.current = true;
                      onManageCustomBots();
                    }}
                  >
                    <PlusIcon size={14} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
              {connecting ? (
                <p className={styles.idHint}>
                  Approve it in the window that opened — this updates by itself.
                </p>
              ) : null}
            </dd>
          </div>
        ) : null}
      </dl>

      {mode === "update" ? (
        <p className={styles.replaceNote}>
          This replaces the whole message with the current draft — anything not rebuilt in the
          editor is overwritten.
        </p>
      ) : null}

      {showPermanent && slots ? (
        <PermanentOptIn
          slots={slots}
          checked={makePermanent}
          onChange={setMakePermanent}
          busy={busy}
          onManageOnWeb={onManageOnWeb}
        />
      ) : null}

      <PingSummaryView pings={pings} />
    </Modal>
  );
}
