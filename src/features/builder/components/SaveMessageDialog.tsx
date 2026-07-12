/**
 * "Save message" dialog — stash the current message under a user-supplied name.
 *
 * Extracted from the old "Saved" dropdown when the action bar went icon-first
 * (the bar's save icon opens this directly, like the Activity bar's). When the
 * connected server has a shared library (proxy configured + server connected +
 * signed in) the dialog offers a destination toggle — this browser's
 * localStorage, or the server library that teammates and the embedded Activity
 * can pick up too. Otherwise it saves to this browser only.
 */

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { normalizeSavedMessageName, useSavedMessagesStore } from "@/core/state/savedMessagesStore";
import { useGuildStore } from "@/core/guild/guildStore";
import { useAuthStore } from "@/core/auth/authStore";
import { isLibraryConfigured } from "@/core/library/api";
import { useLibraryStore } from "@/core/library/libraryStore";
import { cn } from "@/lib/cn";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { Modal } from "@/ui/Modal";
import { TextInput } from "@/ui/TextInput";
import { SaveIcon } from "@/ui/Icon";
import { pushToast } from "@/ui/Toast";
import styles from "./SaveMessageDialog.module.css";

/** Where a save lands: this browser's localStorage, or the connected server's
 *  shared library on the proxy. */
type SaveMode = "local" | "server";

export function SaveMessageDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const currentMessage = useMessageStore((s) => s.message);
  const entries = useSavedMessagesStore((s) => s.entries);
  const saveEntry = useSavedMessagesStore((s) => s.save);

  // "Save to server library" needs somewhere to save to: a configured proxy, a
  // connected server, and a signed-in user (the API is Manage-Webhooks gated —
  // the server answers 403 for a member who can't, surfaced in the dialog).
  const connectedGuildId = useGuildStore((s) => s.guildId);
  const signedIn = useAuthStore((s) => s.status === "authed");
  const serverSaveAvailable = isLibraryConfigured() && !!connectedGuildId && signedIn;
  const serverName = useAuthStore((s) => s.guilds.find((g) => g.id === connectedGuildId)?.name);

  const [name, setName] = useState("");
  // Default to the shared server draft when it's an option — teammates and the
  // Activity can pick it up. Falls back to a browser draft when no server
  // library is available (the toggle is hidden then, so it must be "local").
  const [destination, setDestination] = useState<SaveMode>(
    serverSaveAvailable ? "server" : "local",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset the form whenever the dialog re-opens so old text doesn't leak in.
  useEffect(() => {
    if (open) {
      setName("");
      setDestination(serverSaveAvailable ? "server" : "local");
      setError(null);
      setBusy(false);
      // Modal grabs focus on its dialog by default; defer so we win.
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
  }, [open, serverSaveAvailable]);

  /** Resolves with an error message to keep the dialog open, or null on
   *  success (which closes it). */
  const save = async (trimmed: string): Promise<string | null> => {
    if (destination === "server" && connectedGuildId) {
      const res = await useLibraryStore
        .getState()
        .saveDraft(connectedGuildId, trimmed, currentMessage);
      if (!res.ok) {
        // Quota (409) and permission (403) messages are user-facing — keep the
        // dialog open with the reason so a retry/upgrade path is visible.
        return res.error;
      }
      onClose();
      pushToast(`Saved "${trimmed}" to the ${serverName ?? "server"} library`, "success");
      return null;
    }
    saveEntry(trimmed, currentMessage);
    onClose();
    pushToast(`Saved "${trimmed}"`, "success");
    return null;
  };

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
      entries.some((n) => n.name.toLowerCase() === trimmed.toLowerCase())
    ) {
      setError("You already have a saved message with that name.");
      return;
    }
    setBusy(true);
    void save(trimmed).then((err) => {
      setBusy(false);
      if (err) setError(err);
    });
  };

  return (
    <Modal open={open} onClose={onClose} title="Save message" size="sm">
      <form className={styles.saveForm} onSubmit={submit}>
        {serverSaveAvailable ? (
          <div className={styles.destToggle} role="radiogroup" aria-label="Where to save">
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
              <strong>Server draft</strong>
              <span>Shared in {serverName ?? "this server"}.</span>
            </button>
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
              <strong>Browser draft</strong>
              <span>Saved on this device only.</span>
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
          <Button variant="ghost" onClick={onClose} type="button" disabled={busy}>
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
