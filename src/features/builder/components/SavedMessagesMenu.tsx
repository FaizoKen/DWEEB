/**
 * "Saved" dropdown — replaces the old Reset button.
 *
 * Four jobs:
 *  - Stash the current message under a user-supplied name (localStorage).
 *  - Save it to the connected server's shared library (when a proxy is
 *    configured and a server is connected) so teammates and the embedded
 *    Activity can pick it up too.
 *  - Wipe the editor back to an empty message.
 *  - Jump to the full-screen gallery, where saved messages are browsed, loaded,
 *    and deleted alongside the templates.
 *
 * A short naming dialog appears when the user picks either save action.
 */

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { normalizeSavedMessageName, useSavedMessagesStore } from "@/core/state/savedMessagesStore";
import { usePostedMessagesStore } from "@/core/state/postedMessagesStore";
import { useTemplateGalleryStore } from "@/features/templates/templateGalleryStore";
import { useGuildStore } from "@/core/guild/guildStore";
import { useAuthStore } from "@/core/auth/authStore";
import { isLibraryConfigured } from "@/core/library/api";
import { useLibraryStore } from "@/core/library/libraryStore";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { Menu, MenuItem } from "@/ui/Menu";
import { Modal } from "@/ui/Modal";
import { TextInput } from "@/ui/TextInput";
import {
  BookmarkIcon,
  ChevronDownIcon,
  GlobeIcon,
  SaveIcon,
  SendIcon,
  TemplateIcon,
  TrashIcon,
} from "@/ui/Icon";
import { pushToast } from "@/ui/Toast";
import styles from "./SavedMessagesMenu.module.css";

/** Where a save lands: this browser's localStorage, or the connected server's
 *  shared library on the proxy. */
type SaveMode = "local" | "server";

export function SavedMessagesMenu() {
  const clearAll = useMessageStore((s) => s.clearAll);
  const currentMessage = useMessageStore((s) => s.message);

  const entries = useSavedMessagesStore((s) => s.entries);
  const saveEntry = useSavedMessagesStore((s) => s.save);
  const postedEntries = usePostedMessagesStore((s) => s.entries);

  const openGallery = useTemplateGalleryStore((s) => s.openGallery);

  // "Save to server library" needs somewhere to save to: a configured proxy, a
  // connected server, and a signed-in user (the API is Manage-Webhooks gated —
  // the server answers 403 for a member who can't, surfaced in the dialog).
  const connectedGuildId = useGuildStore((s) => s.guildId);
  const signedIn = useAuthStore((s) => s.status === "authed");
  const serverSaveAvailable = isLibraryConfigured() && !!connectedGuildId && signedIn;
  const connectedGuildName = useAuthStore(
    (s) => s.guilds.find((g) => g.id === connectedGuildId)?.name,
  );

  const [saveMode, setSaveMode] = useState<SaveMode | null>(null);

  const handleSave = async (name: string): Promise<string | null> => {
    if (saveMode === "server" && connectedGuildId) {
      const res = await useLibraryStore
        .getState()
        .saveDraft(connectedGuildId, name, currentMessage);
      if (!res.ok) {
        // Quota (409) and permission (403) messages are user-facing — keep the
        // dialog open with the reason so a retry/upgrade path is visible.
        return res.error;
      }
      setSaveMode(null);
      pushToast(`Saved "${name}" to the ${connectedGuildName ?? "server"} library`, "success");
      return null;
    }
    saveEntry(name, currentMessage);
    setSaveMode(null);
    pushToast(`Saved "${name}"`, "success");
    return null;
  };

  return (
    <>
      <Menu
        align="start"
        trigger={
          <Button
            variant="ghost"
            size="sm"
            leadingIcon={<BookmarkIcon />}
            trailingIcon={<ChevronDownIcon />}
            collapseLabel
            title="Save the current message locally or to the server library, browse saved messages and templates in the gallery, or clear the current message"
          >
            Saved
          </Button>
        }
      >
        {(close) => (
          <div className={styles.menu}>
            <MenuItem
              icon={<SaveIcon />}
              onSelect={() => {
                close();
                setSaveMode("local");
              }}
            >
              Save current message…
            </MenuItem>
            {serverSaveAvailable ? (
              <MenuItem
                icon={<GlobeIcon />}
                onSelect={() => {
                  close();
                  setSaveMode("server");
                }}
              >
                Save to server library…
              </MenuItem>
            ) : null}
            {postedEntries.length > 0 ? (
              <MenuItem
                icon={<SendIcon />}
                onSelect={() => {
                  close();
                  openGallery("Posted");
                }}
              >
                Posted messages ({postedEntries.length})
              </MenuItem>
            ) : null}
            {entries.length > 0 ? (
              <MenuItem
                icon={<BookmarkIcon />}
                onSelect={() => {
                  close();
                  openGallery("Saved");
                }}
              >
                Saved messages ({entries.length})
              </MenuItem>
            ) : null}
            <MenuItem
              icon={<TemplateIcon />}
              onSelect={() => {
                close();
                openGallery();
              }}
            >
              Browse gallery…
            </MenuItem>
            <MenuItem
              icon={<TrashIcon />}
              onSelect={() => {
                close();
                clearAll();
              }}
            >
              Clear current message
            </MenuItem>
          </div>
        )}
      </Menu>

      <SaveMessageDialog
        open={saveMode !== null}
        mode={saveMode ?? "local"}
        serverName={connectedGuildName}
        existingNames={entries.map((e) => e.name)}
        onCancel={() => setSaveMode(null)}
        onSave={handleSave}
      />
    </>
  );
}

interface SaveMessageDialogProps {
  open: boolean;
  mode: SaveMode;
  /** Connected server's name, for the server-save wording. */
  serverName?: string;
  existingNames: string[];
  onCancel: () => void;
  /** Resolves with an error message to keep the dialog open, or null on
   *  success (the caller closes it). */
  onSave: (name: string) => Promise<string | null>;
}

function SaveMessageDialog({
  open,
  mode,
  serverName,
  existingNames,
  onCancel,
  onSave,
}: SaveMessageDialogProps) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset the form whenever the dialog re-opens so old text doesn't leak in.
  useEffect(() => {
    if (open) {
      setName("");
      setError(null);
      setBusy(false);
      // Modal grabs focus on its dialog by default; defer so we win.
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
  }, [open]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const trimmed = normalizeSavedMessageName(name);
    if (!trimmed) {
      setError("Give this message a name to save it.");
      return;
    }
    if (mode === "local" && existingNames.some((n) => n.toLowerCase() === trimmed.toLowerCase())) {
      setError("You already have a saved message with that name.");
      return;
    }
    setBusy(true);
    void onSave(trimmed).then((err) => {
      setBusy(false);
      if (err) setError(err);
    });
  };

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={mode === "server" ? "Save to server library" : "Save message"}
      size="sm"
    >
      <form className={styles.saveForm} onSubmit={submit}>
        <Field
          label="Name"
          hint={
            mode === "server"
              ? `Saved as a draft in the ${serverName ?? "server"} library — visible to everyone who manages that server, from the web app and the Discord Activity.`
              : "A short label so you can find this message again. Stored locally in your browser."
          }
          error={error}
        >
          {(id) => (
            <TextInput
              id={id}
              ref={inputRef}
              value={name}
              onChange={(e) => {
                setName(e.currentTarget.value);
                if (error) setError(null);
              }}
              maxLength={60}
              placeholder="e.g. Announcement template"
              invalid={!!error}
            />
          )}
        </Field>
        <div className={styles.saveActions}>
          <Button variant="ghost" onClick={onCancel} type="button" disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" leadingIcon={<SaveIcon />} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
