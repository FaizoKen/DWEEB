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
 * Presentational: it owns no post logic. Confirming hands back to the bar, which
 * runs `publish()` / `update()` and, on success, opens `PostSuccess`.
 */

import { useMemo } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { useRoleInfo } from "@/core/guild/guildStore";
import { summarizePings, type PingSummary } from "@/core/schema/mentions";
import type { PickerGuild } from "@/core/guild/api";
import { Modal } from "@/ui/Modal";
import { Button } from "@/ui/Button";
import { SendIcon, RefreshIcon } from "@/ui/Icon";
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
  /** Resolved destination channel name (without the leading `#`), when known. */
  channelName?: string;
  /** True while the confirmed post is in flight — drives the button spinner. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
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

export function PostConfirm({
  open,
  mode,
  newCopy = false,
  guild,
  channelName,
  busy = false,
  onConfirm,
  onCancel,
}: PostConfirmProps) {
  const message = useMessageStore((s) => s.message);
  const pings = useMemo(() => summarizePings(message), [message]);

  const title =
    mode === "update"
      ? "Update this message?"
      : newCopy
        ? "Post a new copy?"
        : "Post this message?";
  const action =
    mode === "update"
      ? "Edit the message you posted here"
      : newCopy
        ? "Post a separate new copy into the channel"
        : "Post a new message";
  const confirmLabel = busy
    ? mode === "update"
      ? "Updating…"
      : "Posting…"
    : mode === "update"
      ? "Update message"
      : newCopy
        ? "Post copy"
        : "Post message";

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
            onClick={onConfirm}
            disabled={busy}
            leadingIcon={
              busy ? (
                <span className={styles.spinner} aria-hidden="true" />
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

      <PingSummaryView pings={pings} />
    </Modal>
  );
}
