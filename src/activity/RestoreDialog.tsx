/**
 * Restore dialog — the embedded counterpart to the web app's Restore tab, pared
 * right down.
 *
 * The web flow needs the webhook URL that posted the message (a secret the
 * browser holds). Inside the Activity the proxy already knows the DWEEB-owned
 * webhook for the target channel, so all the user provides is a message id (or a
 * Discord message link). One field, one button — DWEEB does the rest, loads the
 * message into the shared editor, and wires edits to update it in place.
 */

import { useState } from "react";
import { Modal } from "@/ui/Modal";
import { Field } from "@/ui/Field";
import { TextInput } from "@/ui/TextInput";
import { Button } from "@/ui/Button";
import { useActivityStore } from "@/core/activity/activityStore";
import { parseMessageIdInput } from "@/core/webhook/send";
import styles from "./RestoreDialog.module.css";

export function RestoreDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const restore = useActivityStore((s) => s.restore);
  const restoring = useActivityStore((s) => s.restoring);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const messageId = parseMessageIdInput(input);
  // Only flag a malformed entry once something's been typed — an empty field just
  // leaves the button disabled rather than shouting an error.
  const invalid = input.trim().length > 0 && messageId === null;

  const close = () => {
    setInput("");
    setError(null);
    onClose();
  };

  const handleRestore = async () => {
    if (!messageId || restoring) return;
    setError(null);
    try {
      await restore(input);
      close();
    } catch (e) {
      // The store throws a user-facing message; keep the dialog open so the user
      // can fix the id and retry (a wrong/foreign message is the common case).
      setError(e instanceof Error ? e.message : "Couldn't restore the message.");
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Restore a message"
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={close} disabled={restoring}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void handleRestore()}
            disabled={restoring || messageId === null}
          >
            {restoring ? "Restoring…" : "Restore"}
          </Button>
        </>
      }
    >
      <p className={styles.lead}>
        Pull a message <strong>DWEEB posted in this channel</strong> back into the editor. Paste its
        message ID or link — DWEEB finds the webhook for you, and your edits then update that
        message in place.
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
                void handleRestore();
              }
            }}
          />
        )}
      </Field>
      <p className={styles.hint}>
        Right-click the message in Discord → <strong>Copy Message Link</strong> (or Copy Message ID
        with Developer Mode on).
      </p>
    </Modal>
  );
}
