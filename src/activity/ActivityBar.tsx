/**
 * The Activity's top bar — the one piece of chrome the embedded surface adds on
 * top of the reused editor: where the message is going (the channel), undo/redo,
 * and the primary **Post** action. Presence and inviting live in the bottom
 * `PresenceDock` instead.
 *
 * The web app's action bar (account menu, share links, scheduling) is mostly
 * absent: inside Discord the context is fixed and publishing is one server-side
 * call, so this stays focused on "edit together, then post". Restore is the one
 * import it keeps — pulling a message DWEEB posted here back into the editor is
 * just as useful in the room, and the proxy makes it a one-field action.
 */

import { useState } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { useActivityStore } from "@/core/activity/activityStore";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import {
  ExternalLinkIcon,
  GlobeIcon,
  HistoryIcon,
  RedoIcon,
  RefreshIcon,
  SendIcon,
  UndoIcon,
} from "@/ui/Icon";
import { ChannelPicker } from "./ChannelPicker";
import { GuildPicker, ServerGlyph } from "./GuildPicker";
import { RestoreDialog } from "./RestoreDialog";
import styles from "./ActivityBar.module.css";

export function ActivityBar() {
  const undo = useMessageStore((s) => s.undo);
  const redo = useMessageStore((s) => s.redo);
  const canUndo = useMessageStore((s) => s.past.length > 0);
  const canRedo = useMessageStore((s) => s.future.length > 0);

  const publishing = useActivityStore((s) => s.publishing);
  const publish = useActivityStore((s) => s.publish);
  const update = useActivityStore((s) => s.update);
  const openLastPost = useActivityStore((s) => s.openLastPost);
  const openOnWeb = useActivityStore((s) => s.openOnWeb);
  const lastPost = useActivityStore((s) => s.lastPost);
  const targetChannelId = useActivityStore((s) => s.targetChannelId);
  const setTargetChannel = useActivityStore((s) => s.setTargetChannel);

  // A DM / group-DM launch has no guild of its own, so the user first picks a
  // destination *server* (DMs can't receive a webhook post), then a channel.
  const isDm = useActivityStore((s) => s.context != null && s.context.guildId == null);
  const guilds = useActivityStore((s) => s.guilds);
  const guildsLoading = useActivityStore((s) => s.guildsLoading);
  const targetGuildId = useActivityStore((s) => s.targetGuildId);
  const setTargetGuild = useActivityStore((s) => s.setTargetGuild);
  const targetGuildMeta = useActivityStore((s) => s.targetGuildMeta);

  const [restoreOpen, setRestoreOpen] = useState(false);

  const noDestination = !targetGuildId || !targetChannelId;
  // "Update" applies only while the chosen destination still matches where we
  // last posted; re-point the channel/server and the primary reverts to "Post".
  const canUpdate =
    lastPost != null &&
    lastPost.guild_id === targetGuildId &&
    lastPost.channel_id === targetChannelId;

  return (
    <div className={styles.bar}>
      <div className={styles.left}>
        {/* Server indicator, left corner — which server the post lands in. On a
            DM launch it's the destination picker, collapsed to the chosen
            server's icon + dropdown arrow (or a "Pick a server" prompt before
            one's chosen). On a guild launch it's a static icon for the launching
            server — no dropdown, since the server is fixed. */}
        {isDm ? (
          <GuildPicker
            guilds={guilds}
            loading={guildsLoading}
            selectedId={targetGuildId}
            onSelect={setTargetGuild}
            compact
          />
        ) : targetGuildMeta ? (
          <span className={styles.serverBadge} title={`Posting to ${targetGuildMeta.name}`}>
            <ServerGlyph guild={targetGuildMeta} size={28} />
          </span>
        ) : null}

        {/* The channel the post lands in. On a DM launch there are no channels to
            offer until a destination *server* is picked, so the dropdown only
            appears once one is. */}
        {!isDm || targetGuildId ? (
          <ChannelPicker selectedId={targetChannelId} onSelect={setTargetChannel} />
        ) : null}
      </div>

      <div className={styles.right}>
        {/* Restore: pull a message DWEEB posted in this channel back into the
            editor. Needs a destination channel (the webhook lives there), so it's
            disabled until one is picked — same gate as Post. */}
        <IconButton
          label="Restore a message DWEEB posted"
          onClick={() => setRestoreOpen(true)}
          disabled={noDestination}
        >
          <HistoryIcon />
        </IconButton>

        {/* The embedded surface is a focused "edit together, then post" view;
            this hands the current draft off to the full web app (scheduling,
            saved messages, account) for anything it omits. */}
        <IconButton label="Open on web for full features" onClick={() => void openOnWeb()}>
          <GlobeIcon />
        </IconButton>

        <span className={styles.sep} aria-hidden="true" />

        <IconButton label="Undo" onClick={undo} disabled={!canUndo}>
          <UndoIcon />
        </IconButton>
        <IconButton label="Redo" onClick={redo} disabled={!canRedo}>
          <RedoIcon />
        </IconButton>

        <span className={styles.sep} aria-hidden="true" />

        {canUpdate ? (
          <>
            {/* The iframe can't open discord.com itself; openLastPost routes
                through the SDK (see activityStore). */}
            <IconButton label="View the posted message" onClick={() => void openLastPost()}>
              <ExternalLinkIcon />
            </IconButton>
            <Button
              variant="secondary"
              size="sm"
              leadingIcon={<SendIcon />}
              collapseLabel
              onClick={() => void publish()}
              disabled={publishing || noDestination}
              title="Post a separate new copy into the channel"
            >
              New
            </Button>
            <Button
              variant="primary"
              size="sm"
              leadingIcon={<RefreshIcon />}
              onClick={() => void update()}
              disabled={publishing || noDestination}
              title="Update the message you posted with the current draft"
            >
              {publishing ? "Updating…" : "Update"}
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            size="sm"
            leadingIcon={<SendIcon />}
            onClick={() => void publish()}
            disabled={publishing || noDestination}
            title="Post this message into the selected channel"
          >
            {publishing ? "Posting…" : "Post"}
          </Button>
        )}
      </div>

      <RestoreDialog open={restoreOpen} onClose={() => setRestoreOpen(false)} />
    </div>
  );
}
