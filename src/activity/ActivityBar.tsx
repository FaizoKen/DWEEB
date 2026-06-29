/**
 * The Activity's top bar — the one piece of chrome the embedded surface adds on
 * top of the reused editor: where the message is going (the channel), who else
 * is editing (presence), undo/redo, and the primary **Post** action.
 *
 * The web app's action bar (account menu, share links, restore, scheduling) is
 * deliberately absent: inside Discord the context is fixed and publishing is one
 * server-side call, so this stays focused on "edit together, then post".
 */

import { useMessageStore } from "@/core/state/messageStore";
import { useActivityStore } from "@/core/activity/activityStore";
import { colorFor, initial } from "@/core/activity/avatar";
import type { CollabParticipant } from "@/core/activity/collab";
import { Button } from "@/ui/Button";
import { IconButton } from "@/ui/IconButton";
import {
  ExternalLinkIcon,
  GlobeIcon,
  RedoIcon,
  RefreshIcon,
  SendIcon,
  ShareIcon,
  UndoIcon,
} from "@/ui/Icon";
import { ChannelPicker } from "./ChannelPicker";
import { GuildPicker } from "./GuildPicker";
import styles from "./ActivityBar.module.css";

export function ActivityBar() {
  const undo = useMessageStore((s) => s.undo);
  const redo = useMessageStore((s) => s.redo);
  const canUndo = useMessageStore((s) => s.past.length > 0);
  const canRedo = useMessageStore((s) => s.future.length > 0);

  const participants = useActivityStore((s) => s.participants);
  const publishing = useActivityStore((s) => s.publishing);
  const publish = useActivityStore((s) => s.publish);
  const update = useActivityStore((s) => s.update);
  const openLastPost = useActivityStore((s) => s.openLastPost);
  const invite = useActivityStore((s) => s.invite);
  const openOnWeb = useActivityStore((s) => s.openOnWeb);
  const lastPost = useActivityStore((s) => s.lastPost);
  const targetChannelId = useActivityStore((s) => s.targetChannelId);
  const setTargetChannel = useActivityStore((s) => s.setTargetChannel);

  // A DM / group-DM launch has no guild of its own, so the user first picks a
  // destination *server* (DMs can't receive a webhook post), then a channel.
  const isDm = useActivityStore((s) => s.context != null && s.context.guildId == null);
  // Discord's invite dialog only works in a server context (it throws in DMs).
  const canInvite = useActivityStore((s) => s.context?.guildId != null);
  const guilds = useActivityStore((s) => s.guilds);
  const guildsLoading = useActivityStore((s) => s.guildsLoading);
  const targetGuildId = useActivityStore((s) => s.targetGuildId);
  const setTargetGuild = useActivityStore((s) => s.setTargetGuild);

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
        {isDm ? (
          <GuildPicker
            guilds={guilds}
            loading={guildsLoading}
            selectedId={targetGuildId}
            onSelect={setTargetGuild}
          />
        ) : null}
        <ChannelPicker
          selectedId={targetChannelId}
          onSelect={setTargetChannel}
          disabled={isDm && !targetGuildId}
        />
        <Presence participants={participants} />
      </div>

      <div className={styles.right}>
        {canInvite ? (
          <IconButton label="Invite people to edit together" onClick={() => void invite()}>
            <ShareIcon />
          </IconButton>
        ) : null}
        {/* The embedded surface is a focused "edit together, then post" view;
            this hands the current draft off to the full web app (scheduling,
            saved messages, account, restore) for anything it omits. */}
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
    </div>
  );
}

/** Overlapping initial-avatars of everyone currently in the room. Initials over
 *  CDN images so nothing depends on an external fetch inside the sandbox. */
function Presence({ participants }: { participants: CollabParticipant[] }) {
  if (participants.length === 0) return null;
  const shown = participants.slice(0, 5);
  const extra = participants.length - shown.length;
  return (
    <div
      className={styles.presence}
      title={`${participants.length} ${participants.length === 1 ? "person" : "people"} editing`}
    >
      {shown.map((p) => (
        <span key={p.id} className={styles.avatar} style={{ background: colorFor(p.id) }}>
          {initial(p.name)}
        </span>
      ))}
      {extra > 0 ? <span className={styles.more}>+{extra}</span> : null}
    </div>
  );
}
