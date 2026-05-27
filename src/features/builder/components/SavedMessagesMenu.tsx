/**
 * "Saved" dropdown — replaces the old Reset button.
 *
 * Three jobs:
 *  - Stash the current message under a user-supplied name (localStorage).
 *  - Load a previously saved message back into the editor.
 *  - Reset to the default preset (the action this control used to be).
 *
 * Saved messages are listed inline in the menu so loading is one click. Each
 * row carries a delete affordance. A short naming dialog appears when the
 * user picks "Save current message…".
 */

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import {
  normalizeSavedMessageName,
  useSavedMessagesStore,
  type SavedMessageRecord,
} from "@/core/state/savedMessagesStore";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { Menu, MenuDivider, MenuItem } from "@/ui/Menu";
import { Modal } from "@/ui/Modal";
import { TextInput } from "@/ui/TextInput";
import {
  BookmarkIcon,
  ChevronDownIcon,
  RefreshIcon,
  SaveIcon,
  TrashIcon,
} from "@/ui/Icon";
import { pushToast } from "@/ui/Toast";
import styles from "./SavedMessagesMenu.module.css";

export function SavedMessagesMenu() {
  const loadDefaultPreset = useMessageStore((s) => s.loadDefaultPreset);
  const replaceMessage = useMessageStore((s) => s.replaceMessage);
  const currentMessage = useMessageStore((s) => s.message);

  const entries = useSavedMessagesStore((s) => s.entries);
  const saveEntry = useSavedMessagesStore((s) => s.save);
  const loadEntry = useSavedMessagesStore((s) => s.load);
  const removeEntry = useSavedMessagesStore((s) => s.remove);

  const [saveOpen, setSaveOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<SavedMessageRecord | null>(null);

  const handleSave = (name: string) => {
    saveEntry(name, currentMessage);
    setSaveOpen(false);
    pushToast(`Saved "${name}"`, "success");
  };

  const handleLoad = (entry: SavedMessageRecord) => {
    const message = loadEntry(entry.id);
    if (!message) {
      pushToast("Couldn't load that saved message — it may be corrupted.", "error");
      return;
    }
    replaceMessage(message);
    pushToast(`Loaded "${entry.name}"`, "success");
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    removeEntry(pendingDelete.id);
    pushToast(`Deleted "${pendingDelete.name}"`, "info");
    setPendingDelete(null);
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
            title="Save the current message locally, load a saved one, or reset to the default template"
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
            <MenuItem
              icon={<RefreshIcon />}
              onSelect={() => {
                close();
                loadDefaultPreset();
              }}
            >
              Reset to default
            </MenuItem>
            <MenuDivider />
            <div className={styles.sectionLabel}>Saved messages</div>
            {entries.length === 0 ? (
              <div className={styles.empty}>
                Nothing saved yet. Use "Save current message…" to stash this one.
              </div>
            ) : (
              <div className={styles.list}>
                {entries.map((entry) => (
                  <SavedRow
                    key={entry.id}
                    entry={entry}
                    onLoad={() => {
                      close();
                      handleLoad(entry);
                    }}
                    onDelete={() => {
                      close();
                      setPendingDelete(entry);
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </Menu>

      <SaveMessageDialog
        open={saveOpen}
        existingNames={entries.map((e) => e.name)}
        onCancel={() => setSaveOpen(false)}
        onSave={handleSave}
      />

      <DeleteConfirmDialog
        entry={pendingDelete}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </>
  );
}

interface DeleteConfirmDialogProps {
  entry: SavedMessageRecord | null;
  onCancel: () => void;
  onConfirm: () => void;
}

function DeleteConfirmDialog({ entry, onCancel, onConfirm }: DeleteConfirmDialogProps) {
  return (
    <Modal open={!!entry} onClose={onCancel} title="Delete saved message?" size="sm">
      <div className={styles.confirmBody}>
        <p className={styles.confirmText}>
          Permanently delete <strong>"{entry?.name}"</strong>? This can't be undone.
        </p>
        <div className={styles.saveActions}>
          <Button variant="ghost" onClick={onCancel} type="button">
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={onConfirm}
            type="button"
            leadingIcon={<TrashIcon />}
          >
            Delete
          </Button>
        </div>
      </div>
    </Modal>
  );
}

interface SavedRowProps {
  entry: SavedMessageRecord;
  onLoad: () => void;
  onDelete: () => void;
}

function SavedRow({ entry, onLoad, onDelete }: SavedRowProps) {
  return (
    <div className={styles.row}>
      <button
        type="button"
        className={styles.rowLoad}
        onClick={onLoad}
        title={`Load "${entry.name}"`}
      >
        <span className={styles.rowName}>{entry.name}</span>
        <span className={styles.rowMeta}>{formatRelative(entry.savedAt)}</span>
      </button>
      <button
        type="button"
        className={styles.rowDelete}
        onClick={onDelete}
        aria-label={`Delete saved message "${entry.name}"`}
        title="Delete"
      >
        <TrashIcon size={14} />
      </button>
    </div>
  );
}

interface SaveMessageDialogProps {
  open: boolean;
  existingNames: string[];
  onCancel: () => void;
  onSave: (name: string) => void;
}

function SaveMessageDialog({ open, existingNames, onCancel, onSave }: SaveMessageDialogProps) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset the form whenever the dialog re-opens so old text doesn't leak in.
  useEffect(() => {
    if (open) {
      setName("");
      setError(null);
      // Modal grabs focus on its dialog by default; defer so we win.
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
  }, [open]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = normalizeSavedMessageName(name);
    if (!trimmed) {
      setError("Give this message a name to save it.");
      return;
    }
    if (existingNames.some((n) => n.toLowerCase() === trimmed.toLowerCase())) {
      setError("You already have a saved message with that name.");
      return;
    }
    onSave(trimmed);
  };

  return (
    <Modal open={open} onClose={onCancel} title="Save message" size="sm">
      <form className={styles.saveForm} onSubmit={submit}>
        <Field
          label="Name"
          hint="A short label so you can find this message again. Stored locally in your browser."
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
          <Button variant="ghost" onClick={onCancel} type="button">
            Cancel
          </Button>
          <Button variant="primary" type="submit" leadingIcon={<SaveIcon />}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Compact "2m ago" / "yesterday" / "Mar 4" formatter for the menu list. */
function formatRelative(savedAt: number): string {
  const diffMs = Date.now() - savedAt;
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(savedAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
