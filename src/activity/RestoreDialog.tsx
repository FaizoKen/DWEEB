/**
 * Restore dialog — the embedded counterpart to the web app's Restore tab, pared
 * right down.
 *
 * The web flow needs the webhook URL that posted the message (a secret the
 * browser holds). Inside the Activity the proxy already knows the DWEEB-owned
 * webhook for the target channel, so all the user provides is a message id (or a
 * Discord message link). One field, one button — DWEEB does the rest, loads the
 * message into the shared editor, and wires edits to update it in place.
 *
 * One wrinkle the embedded surface adds: the room reads from *one* channel, but a
 * pasted link can point at a different channel in this same server. Rather than
 * dead-end on Discord's "Unknown Channel", the dialog recognises that case and
 * offers to switch the room to that channel and restore there (only the channel
 * moves — the server is fixed). See `core/activity/restoreTarget`.
 */

import { useState } from "react";
import { Modal } from "@/ui/Modal";
import { Field } from "@/ui/Field";
import { TextInput } from "@/ui/TextInput";
import { Button } from "@/ui/Button";
import { ChannelTypeIcon } from "@/ui/Icon";
import { useActivityStore } from "@/core/activity/activityStore";
import { useGuildStore } from "@/core/guild/guildStore";
import { parseMessageIdInput } from "@/core/webhook/send";
import { planRestore } from "@/core/activity/restoreTarget";
import styles from "./RestoreDialog.module.css";

/** The other channel a restore wants to switch to, resolved for the confirm view. */
interface PendingSwitch {
  channelId: string;
  name: string;
  /** Discord channel type, for the leading icon (text/announcement/forum/…). */
  type: number;
}

export function RestoreDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const restore = useActivityStore((s) => s.restore);
  const restoring = useActivityStore((s) => s.restoring);
  const targetGuildId = useActivityStore((s) => s.targetGuildId);
  const targetChannelId = useActivityStore((s) => s.targetChannelId);
  // A server launch's destination channel is shared across the whole room, so a
  // switch moves it for everyone; a DM launch's is local to this composer. Drives
  // the confirmation copy.
  const isDm = useActivityStore((s) => s.context != null && s.context.guildId == null);
  const channelById = useGuildStore((s) => s.data?.channelById);

  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Non-null once a pasted link is found to point at a *different* channel in this
  // server: the dialog swaps to a confirmation before it moves the room there.
  const [pendingSwitch, setPendingSwitch] = useState<PendingSwitch | null>(null);

  const messageId = parseMessageIdInput(input);
  // Only flag a malformed entry once something's been typed — an empty field just
  // leaves the button disabled rather than shouting an error.
  const invalid = input.trim().length > 0 && messageId === null;

  const currentName = targetChannelId ? channelById?.[targetChannelId]?.name : undefined;

  const close = () => {
    setInput("");
    setError(null);
    setPendingSwitch(null);
    onClose();
  };

  // Fire the actual restore, closing on success and surfacing the store's
  // user-facing error (and dropping back to the input view) on failure.
  const runRestore = async (opts?: { switchToChannelId?: string }) => {
    setError(null);
    try {
      await restore(input, opts);
      close();
    } catch (e) {
      // The store throws a user-facing message; keep the dialog open so the user
      // can fix the id and retry (a wrong/foreign message is the common case).
      setPendingSwitch(null);
      setError(e instanceof Error ? e.message : "Couldn't restore the message.");
    }
  };

  const handleRestore = () => {
    if (!messageId || restoring) return;
    // Without a resolved destination the store would just throw its friendly
    // "pick a channel" error — let it, rather than misreading the link here.
    if (!targetGuildId || !targetChannelId) {
      void runRestore();
      return;
    }
    const plan = planRestore(input, {
      guildId: targetGuildId,
      channelId: targetChannelId,
      isKnownChannel: (id) => Boolean(channelById?.[id]),
    });
    if (plan.kind === "foreign") {
      // The room is bound to the server it launched in — a message in another
      // server is the web app's job (it's bound to no server).
      setError(
        "That message is in a different server. This room can only restore messages from the server it launched in — use More ▸ Open on web to work with another server.",
      );
      return;
    }
    if (plan.kind === "switch") {
      // Don't restore yet — confirm the channel move first.
      const ch = channelById?.[plan.channelId];
      setError(null);
      setPendingSwitch({
        channelId: plan.channelId,
        name: ch?.name ?? "that channel",
        type: ch?.type ?? 0,
      });
      return;
    }
    // direct / thread — the store derives the same target from the input.
    void runRestore();
  };

  const confirmSwitch = () => {
    if (!pendingSwitch || restoring) return;
    void runRestore({ switchToChannelId: pendingSwitch.channelId });
  };

  const inConfirm = pendingSwitch !== null;

  return (
    <Modal
      open={open}
      onClose={close}
      title="Restore a message"
      size="sm"
      footer={
        inConfirm ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPendingSwitch(null)}
              disabled={restoring}
            >
              Back
            </Button>
            <Button variant="primary" size="sm" onClick={confirmSwitch} disabled={restoring}>
              {restoring ? "Switching…" : "Switch & restore"}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={close} disabled={restoring}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleRestore}
              disabled={restoring || messageId === null}
            >
              {restoring ? "Restoring…" : "Restore"}
            </Button>
          </>
        )
      }
    >
      {inConfirm && pendingSwitch ? (
        <>
          <p className={styles.lead}>
            That message is in a different channel to the one this room is posting to:
          </p>
          <div className={styles.channelRow}>
            <ChannelTypeIcon type={pendingSwitch.type} size={16} />
            <span className={styles.channelName}>{pendingSwitch.name}</span>
          </div>
          <p className={styles.hint}>
            DWEEB will switch {isDm ? "the destination" : "this room"} to{" "}
            <strong>#{pendingSwitch.name}</strong>
            {currentName ? (
              <>
                {" "}
                (from <strong>#{currentName}</strong>)
              </>
            ) : null}{" "}
            and restore the message there
            {isDm ? "" : " — everyone editing here follows along"}. Your edits then update it in
            place.
          </p>
        </>
      ) : (
        <>
          <p className={styles.lead}>
            Pull a message <strong>DWEEB posted in this server</strong> back into the editor. Paste
            its message ID or link — DWEEB finds the webhook for you, and your edits then update
            that message in place.
          </p>
          <Field
            label="Message ID or link"
            error={invalid ? "Enter a message ID or a Discord message link." : (error ?? undefined)}
          >
            {(id) => (
              <TextInput
                id={id}
                autoFocus
                spellCheck={false}
                value={input}
                placeholder="123456789012345678  —or—  https://discord.com/channels/…"
                invalid={invalid || error !== null}
                onChange={(e) => {
                  setInput(e.currentTarget.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleRestore();
                  }
                }}
              />
            )}
          </Field>
          <p className={styles.hint}>
            Right-click the message in Discord → <strong>Copy Message Link</strong> (or Copy Message
            ID with Developer Mode on). Paste the full link when it's in another channel, a thread,
            or a forum/media post, so DWEEB knows exactly where it lives.
          </p>
        </>
      )}
    </Modal>
  );
}
