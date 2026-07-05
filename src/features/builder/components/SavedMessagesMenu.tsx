/**
 * "Saved" dropdown — replaces the old Reset button.
 *
 * Three jobs:
 *  - Stash the current message under a user-supplied name (localStorage).
 *  - Wipe the editor back to an empty message.
 *  - Jump to the full-screen gallery, where saved messages are browsed, loaded,
 *    and deleted alongside the templates.
 *
 * A short naming dialog appears when the user picks "Save current message…".
 */

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { normalizeSavedMessageName, useSavedMessagesStore } from "@/core/state/savedMessagesStore";
import { usePostedMessagesStore } from "@/core/state/postedMessagesStore";
import { useTemplateGalleryStore } from "@/features/templates/templateGalleryStore";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { Menu, MenuItem } from "@/ui/Menu";
import { Modal } from "@/ui/Modal";
import { TextInput } from "@/ui/TextInput";
import {
  BookmarkIcon,
  ChevronDownIcon,
  SaveIcon,
  SendIcon,
  TemplateIcon,
  TrashIcon,
} from "@/ui/Icon";
import { pushToast } from "@/ui/Toast";
import styles from "./SavedMessagesMenu.module.css";

export function SavedMessagesMenu() {
  const clearAll = useMessageStore((s) => s.clearAll);
  const currentMessage = useMessageStore((s) => s.message);

  const entries = useSavedMessagesStore((s) => s.entries);
  const saveEntry = useSavedMessagesStore((s) => s.save);
  const postedEntries = usePostedMessagesStore((s) => s.entries);

  const openGallery = useTemplateGalleryStore((s) => s.openGallery);

  const [saveOpen, setSaveOpen] = useState(false);

  const handleSave = (name: string) => {
    saveEntry(name, currentMessage);
    setSaveOpen(false);
    pushToast(`Saved "${name}"`, "success");
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
            title="Save the current message locally, browse saved messages and templates in the gallery, or clear the current message"
            // Anchor for the onboarding tour's templates step (see steps.ts).
            data-tour="saved"
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
        open={saveOpen}
        existingNames={entries.map((e) => e.name)}
        onCancel={() => setSaveOpen(false)}
        onSave={handleSave}
      />
    </>
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
