/**
 * Pre-send confirmation dialog.
 *
 * Posting/editing a webhook message is irreversible-ish (you can PATCH, but the
 * ping already fired), so the Send panel pops this summary before the actual
 * POST/PATCH. It restates the two things a user most often gets wrong:
 *   - *where* the message lands — which webhook, in which thread, and (for an
 *     edit) which message id is being overwritten; and
 *   - *who gets pinged* — computed from the message's mention tokens crossed
 *     with its `allowed_mentions` policy, so an `@everyone` that will actually
 *     ring the whole channel is impossible to miss.
 *
 * The dialog is presentational: it owns no send logic. Confirming closes it and
 * hands back to the Send panel, which runs the existing verify + send flow
 * (including the ownership block) and surfaces status inline.
 *
 * It renders through `Modal`'s body portal, so stacking it above the Share
 * dialog's own modal is fine.
 */

import { OWNER_COPY, webhookAvatarUrl, type WebhookOwnerKind } from "@/core/webhook";
import type { PingSummary } from "@/core/schema/mentions";
import { Modal } from "@/ui/Modal";
import { Button } from "@/ui/Button";
import { cn } from "@/lib/cn";
import styles from "./SendConfirm.module.css";

/** Owner-chip colour class, by kind — mirrors the recents list. */
const OWNER_BADGE_CLASS: Record<WebhookOwnerKind, string | undefined> = {
  bot: styles.ownerBot,
  user: styles.ownerUser,
  follower: styles.ownerFollower,
  unknown: undefined,
};

export interface SendConfirmProps {
  open: boolean;
  mode: "new" | "update";
  /** Webhook display name when known (from a verify/save or a saved entry). */
  webhookName?: string;
  /** Owner kind when known; undefined means ownership is verified on confirm. */
  ownerKind?: WebhookOwnerKind;
  /** Webhook snowflake — used to resolve the avatar from Discord's CDN. */
  webhookId?: string;
  /** Avatar hash (from a saved entry); null/undefined falls back to the default. */
  webhookAvatar?: string | null;
  /** Guild the webhook posts to, when known (verified or from a saved entry). */
  guildId?: string;
  /** Channel the webhook posts to, when known (verified or from a saved entry). */
  channelId?: string;
  /** Resolved server name, when known — shown instead of the guild snowflake. */
  guildName?: string;
  /** Resolved channel name, when known — shown (as `#name`) instead of the id. */
  channelName?: string;
  /** Target thread id, when posting into a thread. */
  threadId?: string;
  /** Message id being overwritten, in update mode. */
  messageId?: string;
  /** Who the message will ping, after `allowed_mentions`. */
  pings: PingSummary;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Render a short, readable list of snowflake chips, with a "+N more" tail. */
function IdChips({ prefix, ids, max = 6 }: { prefix: string; ids: string[]; max?: number }) {
  const shown = ids.slice(0, max);
  const rest = ids.length - shown.length;
  return (
    <span className={styles.chips}>
      {shown.map((id) => (
        <code key={id} className={styles.chip}>
          {prefix}
          {id}
        </code>
      ))}
      {rest > 0 ? <span className={styles.chipMore}>+{rest} more</span> : null}
    </span>
  );
}

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
            {roleIds.length} role{roleIds.length === 1 ? "" : "s"}:{" "}
            <IdChips prefix="@&" ids={roleIds} />
          </li>
        ) : null}
        {userIds.length > 0 ? (
          <li>
            {userIds.length} user{userIds.length === 1 ? "" : "s"}:{" "}
            <IdChips prefix="@" ids={userIds} />
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

export function SendConfirm({
  open,
  mode,
  webhookName,
  ownerKind,
  webhookId,
  webhookAvatar,
  guildId,
  channelId,
  guildName,
  channelName,
  threadId,
  messageId,
  pings,
  onConfirm,
  onCancel,
}: SendConfirmProps) {
  const hasOwner = ownerKind != null && ownerKind !== "unknown";
  const targetName = webhookName?.trim() || "this webhook";

  return (
    <Modal
      open={open}
      onClose={onCancel}
      size="sm"
      title={mode === "update" ? "Update this message?" : "Post this message?"}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm}>
            {mode === "update" ? "Update message" : "Post message"}
          </Button>
        </>
      }
    >
      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt>Action</dt>
          <dd>
            {mode === "update" ? "Edit an existing message in place (PATCH)" : "Post a new message"}
          </dd>
        </div>
        <div className={styles.fact}>
          <dt>Webhook</dt>
          <dd>
            <div className={styles.webhook}>
              {webhookId ? (
                <img
                  className={styles.avatar}
                  src={webhookAvatarUrl(webhookId, webhookAvatar)}
                  alt=""
                  loading="lazy"
                  onError={(e) => {
                    const img = e.currentTarget;
                    const fallback = webhookAvatarUrl(webhookId, null);
                    if (img.src !== fallback) img.src = fallback;
                  }}
                />
              ) : null}
              <span className={styles.webhookName}>{targetName}</span>
              {hasOwner ? (
                <span
                  className={cn(styles.badge, OWNER_BADGE_CLASS[ownerKind!])}
                  title={OWNER_COPY[ownerKind!].label}
                >
                  {OWNER_COPY[ownerKind!].badge}
                </span>
              ) : null}
            </div>
            {!hasOwner ? (
              <div className={styles.muted}>Ownership is verified when you confirm.</div>
            ) : null}
          </dd>
        </div>
        {guildId || guildName ? (
          <div className={styles.fact}>
            <dt>Server</dt>
            <dd>
              {guildName ? (
                <span className={styles.destName} title={guildId}>
                  {guildName}
                </span>
              ) : (
                <code className={styles.chip}>{guildId}</code>
              )}
            </dd>
          </div>
        ) : null}
        {channelId || channelName ? (
          <div className={styles.fact}>
            <dt>Channel</dt>
            <dd>
              {channelName ? (
                <span className={styles.destName} title={channelId}>
                  #{channelName}
                </span>
              ) : (
                <code className={styles.chip}>{channelId}</code>
              )}
              {guildId && channelId ? (
                <a
                  className={styles.openChannel}
                  href={`https://discord.com/channels/${guildId}/${channelId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open ↗
                </a>
              ) : null}
            </dd>
          </div>
        ) : null}
        {threadId ? (
          <div className={styles.fact}>
            <dt>Thread</dt>
            <dd>
              <code className={styles.chip}>{threadId}</code>
            </dd>
          </div>
        ) : null}
        {mode === "update" && messageId ? (
          <div className={styles.fact}>
            <dt>Message</dt>
            <dd>
              <code className={styles.chip}>{messageId}</code>
            </dd>
          </div>
        ) : null}
      </dl>

      <PingSummaryView pings={pings} />
    </Modal>
  );
}
