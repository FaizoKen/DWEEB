/**
 * "Saved" dropdown — replaces the old Reset button.
 *
 * Three jobs:
 *  - Stash the current message under a user-supplied name. A short naming
 *    dialog appears; when the connected server has a shared library (proxy
 *    configured + server connected + signed in) that dialog also offers a
 *    destination toggle — this browser's localStorage, or the server library
 *    that teammates and the embedded Activity can pick up too.
 *  - Wipe the editor back to an empty message.
 *  - Jump to the full-screen gallery for posted or saved messages when those
 *    lists exist.
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
import { cn } from "@/lib/cn";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { Menu, MenuItem } from "@/ui/Menu";
import { Modal } from "@/ui/Modal";
import { TextInput } from "@/ui/TextInput";
import { BookmarkIcon, ChevronDownIcon, SaveIcon, SendIcon, TrashIcon } from "@/ui/Icon";
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

  const [saveOpen, setSaveOpen] = useState(false);

  const handleSave = async (name: string, destination: SaveMode): Promise<string | null> => {
    if (destination === "server" && connectedGuildId) {
      const res = await useLibraryStore
        .getState()
        .saveDraft(connectedGuildId, name, currentMessage);
      if (!res.ok) {
        // Quota (409) and permission (403) messages are user-facing — keep the
        // dialog open with the reason so a retry/upgrade path is visible.
        return res.error;
      }
      setSaveOpen(false);
      pushToast(`Saved "${name}" to the ${connectedGuildName ?? "server"} library`, "success");
      return null;
    }
    saveEntry(name, currentMessage);
    setSaveOpen(false);
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
                setSaveOpen(true);
              }}
            >
              Save current message…
            </MenuItem>
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
        open={saveOpen}
        serverSaveAvailable={serverSaveAvailable}
        serverName={connectedGuildName}
        existingNames={entries.map((e) => e.name)}
        onCancel={() => setSaveOpen(false)}
        onSave={handleSave}
      />
    </>
  );
}

interface SaveMessageDialogProps {
  open: boolean;
  /** Whether the connected server exposes a shared library. When true the
   *  dialog shows a destination toggle; when false it only saves to this
   *  browser. */
  serverSaveAvailable: boolean;
  /** Connected server's name, for the server-save wording. */
  serverName?: string;
  existingNames: string[];
  onCancel: () => void;
  /** Resolves with an error message to keep the dialog open, or null on
   *  success (the caller closes it). */
  onSave: (name: string, destination: SaveMode) => Promise<string | null>;
}

function SaveMessageDialog({
  open,
  serverSaveAvailable,
  serverName,
  existingNames,
  onCancel,
  onSave,
}: SaveMessageDialogProps) {
  const [name, setName] = useState("");
  const [destination, setDestination] = useState<SaveMode>("local");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset the form whenever the dialog re-opens so old text doesn't leak in.
  useEffect(() => {
    if (open) {
      setName("");
      setDestination("local");
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
    if (
      destination === "local" &&
      existingNames.some((n) => n.toLowerCase() === trimmed.toLowerCase())
    ) {
      setError("You already have a saved message with that name.");
      return;
    }
    setBusy(true);
    void onSave(trimmed, destination).then((err) => {
      setBusy(false);
      if (err) setError(err);
    });
  };

  return (
    <Modal open={open} onClose={onCancel} title="Save message" size="sm">
      <form className={styles.saveForm} onSubmit={submit}>
        {serverSaveAvailable ? (
          <div className={styles.destToggle} role="radiogroup" aria-label="Where to save">
            <button
              type="button"
              role="radio"
              aria-checked={destination === "local"}
              className={cn(styles.destOption, destination === "local" && styles.destOptionActive)}
              onClick={() => {
                setDestination("local");
                setError(null);
              }}
            >
              <strong>This browser</strong>
              <span>Saved on this device only.</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={destination === "server"}
              className={cn(styles.destOption, destination === "server" && styles.destOptionActive)}
              onClick={() => {
                setDestination("server");
                setError(null);
              }}
            >
              <strong>Server library</strong>
              <span>Shared in {serverName ?? "this server"}.</span>
            </button>
          </div>
        ) : null}
        <Field
          label="Name"
          hint={
            destination === "server"
              ? `Saved as a draft in the ${serverName ?? "server"} library — visible to everyone who manages that server, from the web app and the Discord Activity.`
              : serverSaveAvailable
                ? "A short label so you can find this message again."
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
