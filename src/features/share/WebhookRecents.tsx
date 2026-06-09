/**
 * Recent-webhooks list — shared by the Send and Restore panels.
 *
 * Renders the webhooks saved in this browser (see `core/webhook/history`) as
 * clickable rows. Clicking one fills the panel's webhook field via `onUse`.
 * The row whose id matches `activeId` — the webhook id parsed from whatever
 * URL is currently in that field — is highlighted, so it's clear which saved
 * entry the panel is acting on.
 *
 * History is owned by the parent panel (which also reads it — e.g. the Send
 * panel's ownership/name lookups) and passed in; the forget action here mutates
 * localStorage and then calls `onChange` so the parent reloads its copy and the
 * list re-renders.
 */

import { useEffect, useRef, useState } from "react";
import { useAuthStore } from "@/core/auth/authStore";
import { useGuildStore } from "@/core/guild/guildStore";
import {
  classifyWebhookOwner,
  forgetWebhook,
  markWebhookGone,
  OWNER_COPY,
  parseWebhookUrl,
  refreshWebhook,
  verifyWebhook,
  webhookAvatarHash,
  webhookAvatarUrl,
  webhookChannelId,
  webhookGuildId,
  type WebhookHistoryEntry,
  type WebhookOwnerKind,
} from "@/core/webhook";
import { ChevronRightIcon, SettingsIcon, TrashIcon } from "@/ui/Icon";
import { IconButton } from "@/ui/IconButton";
import { pushToast } from "@/ui/Toast";
import { cn } from "@/lib/cn";
import { WebhookManageDialog } from "./WebhookManageDialog";
import styles from "./WebhookRecents.module.css";

/** CSS-module class for each owner chip, by kind. */
const OWNER_BADGE_CLASS: Record<WebhookOwnerKind, string | undefined> = {
  bot: styles.ownerBot,
  user: styles.ownerUser,
  follower: styles.ownerFollower,
  unknown: styles.ownerUnknown,
};

/**
 * When each saved webhook was last health-checked (verify GET), by id. Module
 * scope so it survives the remounts that come with switching the Send/Restore
 * tab or reopening the dialog — a check is good for a few minutes, and we don't
 * want to re-ping Discord on every open. Inconclusive results (offline, rate
 * limit) are left unrecorded so they retry next time.
 */
const healthCheckedAt = new Map<string, number>();
const HEALTH_TTL_MS = 5 * 60_000;

export function WebhookRecents({
  history,
  activeId,
  onUse,
  onChange,
}: {
  /** Saved entries to show, owned by the parent panel. */
  history: WebhookHistoryEntry[];
  /** Webhook id of the URL currently in the field — its row is highlighted. */
  activeId: string | null;
  /** Fill the panel's webhook field from the clicked entry. */
  onUse: (entry: WebhookHistoryEntry) => void;
  /** Called after a rename/forget so the parent can reload its history copy. */
  onChange: () => void;
}) {
  // The entry whose "Manage on Discord" dialog is open, if any.
  const [managing, setManaging] = useState<WebhookHistoryEntry | null>(null);
  // Whether the "other servers" group is expanded (collapsed by default while a
  // guild is connected, so the current guild's webhooks are what you click).
  const [showOthers, setShowOthers] = useState(false);

  // For distinguishing same-named webhooks (every webhook.incoming one is named
  // after the app), resolve each entry's destination. Prefer the names captured
  // at creation (work even when signed out); otherwise resolve live from loaded
  // data — the server from the user's guild list, the channel from the connected
  // guild. When nothing resolves we fall back to the webhook id.
  const guilds = useAuthStore((s) => s.guilds);
  const connectedData = useGuildStore((s) => s.data);
  const connectedId = useGuildStore((s) => s.guildId);

  // Re-collapse "other servers" when you switch the connected guild.
  useEffect(() => setShowOthers(false), [connectedId]);

  // Health-check the saved webhooks against Discord when the list mounts: each
  // already carries its own token, so a token GET (no auth) tells us whether the
  // webhook still exists and refreshes its name/avatar/destination if it changed
  // — surfacing a deleted webhook here, instead of letting the user compose a
  // message and only fail at send. Only entries not checked within the TTL are
  // hit; `onChange` reloads the parent's copy once, and only if something moved.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    const due = history.filter((e) => {
      const last = healthCheckedAt.get(e.id);
      return last === undefined || Date.now() - last > HEALTH_TTL_MS;
    });
    if (due.length === 0) return;

    const ac = new AbortController();
    void Promise.all(
      due.map(async (entry): Promise<boolean> => {
        const parsed = parseWebhookUrl(entry.url);
        if (!parsed) return false;
        const res = await verifyWebhook(parsed, { signal: ac.signal });
        if (res.ok) {
          healthCheckedAt.set(entry.id, Date.now());
          return refreshWebhook(entry.id, {
            name: typeof res.webhook.name === "string" ? res.webhook.name : undefined,
            avatar: webhookAvatarHash(res.webhook),
            ownerKind: classifyWebhookOwner(res.webhook).kind,
            channelId: webhookChannelId(res.webhook) ?? undefined,
            guildId: webhookGuildId(res.webhook) ?? undefined,
          });
        }
        // 404 (deleted) / 401 (token revoked) are definitive — flag it gone.
        if (res.status === 404 || res.status === 401) {
          healthCheckedAt.set(entry.id, Date.now());
          return markWebhookGone(entry.id);
        }
        // Network/abort (status 0) or transient (429/5xx): inconclusive. Leave
        // the entry untouched and unrecorded so the next open retries it.
        return false;
      }),
    ).then((results) => {
      if (!ac.signal.aborted && results.some(Boolean)) onChangeRef.current();
    });

    return () => ac.abort();
  }, [history]);

  const describeDestination = (entry: WebhookHistoryEntry): string | null => {
    const liveServer = entry.guildId ? guilds.find((g) => g.id === entry.guildId)?.name : undefined;
    // `channelById` only holds the connected guild's channels, so a match means
    // the channel really is there — no separate guild check needed.
    const liveChannel = entry.channelId
      ? connectedData?.channelById[entry.channelId]?.name
      : undefined;

    const channel = entry.channelName ?? liveChannel;
    const server = entry.guildName ?? liveServer;
    if (channel && server) return `#${channel} · ${server}`;
    if (channel) return `#${channel}`;
    if (server) return server;
    return null;
  };

  if (history.length === 0) return null;

  const handleForget = (entry: WebhookHistoryEntry) => {
    forgetWebhook(entry.id);
    onChange();
    pushToast("Webhook removed from this browser.", "info");
  };

  const renderRow = (entry: WebhookHistoryEntry) => {
    // Prefer the resolved destination (server · #channel) so same-named
    // webhooks are distinguishable; fall back to the webhook id.
    const destination = describeDestination(entry);
    // A health check found this one deleted/revoked on Discord — it stays in the
    // list (struck through, with a clear remove) rather than vanishing silently.
    const deleted = !!entry.deletedAt;
    return (
      <li
        key={entry.id}
        className={cn(
          styles.historyItem,
          entry.id === activeId && styles.historyItemActive,
          deleted && styles.historyItemDeleted,
        )}
      >
        <button type="button" className={styles.historyButton} onClick={() => onUse(entry)}>
          <span className={styles.historyLabel}>
            <img
              className={styles.historyAvatar}
              src={webhookAvatarUrl(entry.id, entry.avatar)}
              alt=""
              loading="lazy"
              onError={(e) => {
                const img = e.currentTarget;
                const fallback = webhookAvatarUrl(entry.id, null);
                if (img.src !== fallback) img.src = fallback;
              }}
            />
            <span className={styles.historyText}>{entry.name || "(unlabeled)"}</span>
            {deleted ? (
              <span
                className={cn(styles.ownerBadge, styles.ownerBadgeSm, styles.ownerGone)}
                title="This webhook no longer exists on Discord — remove it."
              >
                Gone
              </span>
            ) : entry.ownerKind && entry.ownerKind !== "unknown" ? (
              <span
                className={cn(
                  styles.ownerBadge,
                  styles.ownerBadgeSm,
                  OWNER_BADGE_CLASS[entry.ownerKind],
                )}
                title={OWNER_COPY[entry.ownerKind].label}
              >
                {OWNER_COPY[entry.ownerKind].badge}
              </span>
            ) : null}
          </span>
          {destination ? (
            <span className={styles.historyDest} title={`id · ${entry.id}`}>
              {destination}
            </span>
          ) : (
            <span className={styles.historyId}>id · {entry.id}</span>
          )}
        </button>
        {/* Manage on Discord (rename / avatar / delete) — pointless once a health
            check has found it gone, so it's hidden for those. */}
        {!deleted ? (
          <IconButton size="sm" label="Manage on Discord" onClick={() => setManaging(entry)}>
            <SettingsIcon size={12} />
          </IconButton>
        ) : null}
        <IconButton
          size="sm"
          variant="danger"
          label="Remove from this browser"
          onClick={() => handleForget(entry)}
        >
          <TrashIcon size={12} />
        </IconButton>
      </li>
    );
  };

  // Surface the connected guild's webhooks first; collapse everything else behind
  // a toggle so a click while working in one server can't accidentally post to
  // another. With no guild connected there's nothing to prioritise — show all
  // directly. With a guild connected, the non-matching entries always go in the
  // collapsed "other servers" group; if none match, the primary list is empty
  // and every entry sits behind the toggle, so reaching one from elsewhere takes
  // a deliberate expand.
  const hasGuild = connectedId !== "";
  const primary = hasGuild ? history.filter((e) => e.guildId === connectedId) : history;
  const others = hasGuild ? history.filter((e) => e.guildId !== connectedId) : [];

  return (
    <div className={styles.history}>
      <div className={styles.historyTitle}>Recent webhooks (this browser)</div>
      {primary.length > 0 ? (
        <ul className={styles.historyList}>{primary.map(renderRow)}</ul>
      ) : null}
      {others.length > 0 ? (
        <>
          {primary.length === 0 ? (
            <p className={styles.othersEmpty}>No saved webhooks for this server.</p>
          ) : null}
          <button
            type="button"
            className={styles.othersToggle}
            aria-expanded={showOthers}
            onClick={() => setShowOthers((v) => !v)}
          >
            <ChevronRightIcon
              size={11}
              className={cn(styles.othersChevron, showOthers && styles.othersChevronOpen)}
            />
            {others.length} webhook{others.length === 1 ? "" : "s"} in other servers
          </button>
          {showOthers ? <ul className={styles.historyList}>{others.map(renderRow)}</ul> : null}
        </>
      ) : null}
      {managing ? (
        <WebhookManageDialog
          entry={managing}
          onClose={() => setManaging(null)}
          onChange={onChange}
        />
      ) : null}
    </div>
  );
}
