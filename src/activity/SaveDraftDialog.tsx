/**
 * Save the Activity's current shared message as a named server draft.
 *
 * The web builder also offers a browser-local destination. Inside Discord the
 * useful destination is already unambiguous, so this version is deliberately
 * smaller: one name, one server-backed save. The library client supplies the
 * Activity bearer token and the server handles permission and quota checks.
 */

import { useState } from "react";
import { useLibraryStore } from "@/core/library/libraryStore";
import { useMessageStore } from "@/core/state/messageStore";
import { normalizeSavedMessageName } from "@/core/state/savedMessagesStore";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { SaveIcon } from "@/ui/Icon";
import { Modal } from "@/ui/Modal";
import { TextInput } from "@/ui/TextInput";
import { pushToast } from "@/ui/Toast";
import styles from "./SaveDraftDialog.module.css";

interface SaveDraftDialogProps {
  open: boolean;
  guildId: string | null;
  serverName?: string;
  onClose: () => void;
}

export function SaveDraftDialog({ open, guildId, serverName, onClose }: SaveDraftDialogProps) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const close = () => {
    // Keep the request/result paired with this dialog. The footer is already
    // disabled while saving; apply the same rule to Escape, backdrop and ×.
    if (saving) return;
    setName("");
    setError(null);
    onClose();
  };

  const handleSave = async () => {
    if (saving) return;
    const normalized = normalizeSavedMessageName(name);
    if (!normalized) {
      setError("Give this draft a name so you can find it again.");
      return;
    }
    if (!guildId) {
      setError("Pick a server before saving this draft.");
      return;
    }

    setSaving(true);
    setError(null);
    // Read at submit time, not when the dialog opened: collaborators may have
    // kept editing while this user was naming the draft.
    const message = useMessageStore.getState().message;
    const result = await useLibraryStore.getState().saveDraft(guildId, normalized, message);
    setSaving(false);
    if (!result.ok) {
      // Permission, quota, storage and network errors are already user-facing.
      // Keep the name/dialog intact so the user can fix the issue and retry.
      setError(result.error);
      return;
    }

    close();
    pushToast(
      `Saved “${normalized}” to ${serverName ? `${serverName}'s` : "the server's"} drafts`,
      "success",
    );
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Save server draft"
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={close} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            leadingIcon={<SaveIcon />}
            onClick={() => void handleSave()}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save draft"}
          </Button>
        </>
      }
    >
      <p className={styles.lead}>
        Save the current shared message in <strong>{serverName ?? "this server"}</strong>. Anyone
        who manages the server can load it from the Message directory.
      </p>
      <Field
        label="Draft name"
        hint="A short label makes this message easy to find later."
        error={error}
      >
        {(id) => (
          <TextInput
            id={id}
            autoFocus
            value={name}
            maxLength={60}
            placeholder="e.g. Weekly announcement"
            invalid={error !== null}
            onChange={(event) => {
              setName(event.currentTarget.value);
              if (error) setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void handleSave();
              }
            }}
          />
        )}
      </Field>
    </Modal>
  );
}
