/**
 * Post-success dialog — the Activity's counterpart to the web app's
 * `SendSuccess`.
 *
 * Once a publish/update lands, the bar pops this so the result is unmissable and
 * the user can jump straight to the message in Discord. The mirror image of
 * `PostConfirm`: where that restates *where* the message will land before
 * posting, this confirms it got there and offers a jump link.
 *
 * The sandboxed iframe can't navigate to discord.com itself, so "View in
 * Discord" routes through the SDK (`openLastPost` in the store) rather than a
 * plain anchor. Purely presentational otherwise: "Done" just closes it.
 */

import { Modal } from "@/ui/Modal";
import { Button } from "@/ui/Button";
import { CheckCircleIcon, ExternalLinkIcon } from "@/ui/Icon";
import type { PickerGuild } from "@/core/guild/api";
import { ServerGlyph } from "./GuildPicker";
import styles from "./PostSuccess.module.css";

export interface PostSuccessProps {
  open: boolean;
  /** Whether the message was freshly posted ("new") or edited in place. */
  mode: "new" | "update";
  /** Destination server, for the icon + name. Null when its meta isn't known. */
  guild?: PickerGuild | null;
  /** Resolved destination channel name (without the leading `#`), when known. */
  channelName?: string;
  /** Whether the posted message has a jump link (the post returned a URL). When
   *  false only "Done" shows — there's nowhere to jump to. */
  canView: boolean;
  /** Open the posted message in Discord — routed through the SDK by the store. */
  onView: () => void;
  /** True when a never-expire slot was claimed — shows a "won't expire" receipt
   *  for the message's interactive components. */
  permanent?: boolean;
  /** A reason the requested never-expire claim couldn't be granted (e.g. slots
   *  full) — shown with a "manage on web" hand-off. Null/absent when there's
   *  nothing to report. */
  permanentError?: string | null;
  /** Hand off to the web app — used by the never-expire error's manage action. */
  onManageOnWeb?: () => void;
  onClose: () => void;
}

export function PostSuccess({
  open,
  mode,
  guild,
  channelName,
  canView,
  onView,
  permanent = false,
  permanentError,
  onManageOnWeb,
  onClose,
}: PostSuccessProps) {
  // Tail of the banner sentence — names the destination when we have it.
  const where =
    channelName && guild ? (
      <>
        It’s live in <strong>#{channelName}</strong> on <strong>{guild.name}</strong>.
      </>
    ) : channelName ? (
      <>
        It’s live in <strong>#{channelName}</strong>.
      </>
    ) : (
      <>It’s live in the channel.</>
    );

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={mode === "update" ? "Message updated" : "Message posted"}
      footer={
        canView ? (
          <>
            <Button variant="secondary" size="sm" onClick={onClose}>
              Done
            </Button>
            <Button
              variant="primary"
              size="sm"
              leadingIcon={<ExternalLinkIcon />}
              onClick={() => {
                onView();
                onClose();
              }}
            >
              View in Discord
            </Button>
          </>
        ) : (
          <Button variant="primary" size="sm" onClick={onClose}>
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
        {permanent ? (
          <div className={styles.fact}>
            <dt>Interaction</dt>
            <dd>Never expires — its buttons &amp; selects keep working.</dd>
          </div>
        ) : null}
      </dl>

      {permanentError ? (
        <div className={styles.permanentError} role="note">
          <p className={styles.permanentErrorText}>
            Couldn’t keep its buttons &amp; selects from expiring: {permanentError}
          </p>
          {onManageOnWeb ? (
            <Button size="sm" variant="secondary" onClick={onManageOnWeb}>
              Manage on web ↗
            </Button>
          ) : null}
        </div>
      ) : null}

      {mode === "new" ? (
        <p className={styles.note}>
          This message is now linked — hit <strong>Update</strong> to edit it in place. Posting
          again drops a separate new copy.
        </p>
      ) : null}
    </Modal>
  );
}
