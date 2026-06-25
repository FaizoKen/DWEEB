/**
 * Post-send success dialog.
 *
 * Once a webhook POST/PATCH lands, the Send panel pops this so the result is
 * unmissable and the user can jump straight to the message in Discord. It's the
 * mirror image of `SendConfirm`: where that one restates *where* the message
 * will land before sending, this one confirms it got there and offers a deep
 * link — to the exact message when the id is known, otherwise to the channel.
 *
 * Purely presentational: the panel resolves the destination + link and passes
 * them in; "Done" just closes it, "Open in Discord" opens the link and closes.
 *
 * Like `SendConfirm`, it renders through `Modal`'s body portal, so stacking it
 * above the Share dialog's own modal is fine.
 */

import { webhookAvatarUrl } from "@/core/webhook";
import { openDiscordLink } from "@/lib/discordDeepLink";
import { Modal } from "@/ui/Modal";
import { Button } from "@/ui/Button";
import { CheckCircleIcon } from "@/ui/Icon";
import { PermanentStatusValue, type PermanentStatusProps } from "./PermanentStatus";
import styles from "./SendSuccess.module.css";

export interface SendSuccessProps {
  open: boolean;
  mode: "new" | "update";
  /** Webhook display name when known. */
  webhookName?: string;
  /** Webhook snowflake — resolves the avatar from Discord's CDN. */
  webhookId?: string;
  /** Avatar hash; null/undefined falls back to the default. */
  webhookAvatar?: string | null;
  /** Destination guild, when resolved. */
  guildId?: string;
  /** Destination channel, when resolved. */
  channelId?: string;
  /** Resolved server name — shown instead of the guild snowflake. */
  guildName?: string;
  /** Resolved channel name — shown (as `#name`) instead of the channel id. */
  channelName?: string;
  /**
   * Deep link to the posted/edited message (or its channel when the message id
   * isn't known). Null when the destination guild/channel couldn't be resolved,
   * in which case only the "Done" button shows.
   */
  discordUrl?: string | null;
  /**
   * True when the Send panel re-targeted itself at the posted message, so
   * sending again edits it in place. Shown as a note after a "new" post —
   * after an update the panel was already pointing at the message.
   */
  editOnResend?: boolean;
  /** The posted/edited message's id, when the response carried it. */
  messageId?: string;
  /**
   * Read-only component-expiry receipt for messages with interactive plugin
   * components — permanence was decided in the confirm dialog; this only
   * reports how it ended up, as an "Interaction" row in the facts list.
   * Undefined hides the row (no interactive components, feature off, or
   * components never expire on this deployment).
   */
  permanentStatus?: Omit<PermanentStatusProps, "messageId">;
  onClose: () => void;
}

export function SendSuccess({
  open,
  mode,
  webhookName,
  webhookId,
  webhookAvatar,
  guildId,
  channelId,
  guildName,
  channelName,
  discordUrl,
  editOnResend,
  messageId,
  permanentStatus,
  onClose,
}: SendSuccessProps) {
  const name = webhookName?.trim() || "this webhook";

  // Tail of the banner sentence — names the destination when we have it.
  const where =
    channelName && guildName ? (
      <>
        It’s live in <strong>#{channelName}</strong> on <strong>{guildName}</strong>.
      </>
    ) : channelName ? (
      <>
        It’s live in <strong>#{channelName}</strong>.
      </>
    ) : (
      <>It’s live in Discord.</>
    );

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={mode === "update" ? "Message updated" : "Message posted"}
      footer={
        discordUrl ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              Done
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                // Prefer the desktop app (falls back to the web link); on mobile
                // the https link is itself an app link. See openDiscordLink.
                openDiscordLink(discordUrl);
                onClose();
              }}
            >
              Open in Discord ↗
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        )
      }
    >
      <div className={styles.banner} role="status">
        <span className={styles.check} aria-hidden="true">
          <CheckCircleIcon size={20} />
        </span>
        <p className={styles.bannerText}>
          {mode === "update"
            ? "Your message was updated in place. "
            : "Your message was delivered. "}
          {where}
        </p>
      </div>

      <dl className={styles.facts}>
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
              <span className={styles.webhookName}>{name}</span>
            </div>
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
            </dd>
          </div>
        ) : null}
        {permanentStatus ? (
          <div className={styles.fact}>
            <dt>Interaction</dt>
            <dd>
              <PermanentStatusValue messageId={messageId} {...permanentStatus} />
            </dd>
          </div>
        ) : null}
      </dl>

      {mode === "new" && editOnResend ? (
        <p className={styles.note}>
          This message is now linked — hit <strong>Update</strong> (the toolbar button, or the{" "}
          <strong>Update</strong> tab) to edit it in place. Sending from here again posts a new
          message.
        </p>
      ) : null}
    </Modal>
  );
}
