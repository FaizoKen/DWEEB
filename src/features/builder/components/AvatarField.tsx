/**
 * The webhook "Avatar URL" control: the URL input, plus an inset Upload button
 * that turns a local image into a permanent public URL.
 *
 * Deliberately still a URL field. Uploading is an *additional* way to fill it,
 * not a replacement mode, because the field has to keep accepting things an
 * upload can't express — an existing CDN link and the `{server_icon}`
 * placeholder, which resolves per-server at send time. So there is no
 * upload/paste toggle: you can always type, and uploading simply writes the
 * resulting URL into the same input.
 *
 * The Upload button is positioned *inside* the input rather than beside it so
 * the field keeps the full width of its grid column, staying visually identical
 * to the Username field next to it. A sibling button would shorten the input
 * and make the two-column meta row look ragged.
 *
 * There is intentionally no thumbnail here and no permanent hint line: the
 * message preview already renders the avatar (`Preview.tsx` reads the same
 * `avatar_url`), so a second copy beside the input is redundant, and a static
 * caption under a self-evident control is noise. Upload failures surface as a
 * toast, which keeps the field's height stable instead of shifting the layout
 * whenever an error appears and clears.
 *
 * The upload affordance hides itself entirely when the proxy reports the
 * feature off (`avatarUploads` in `/api/capabilities`), leaving precisely the
 * field that existed before. See `core/avatar/availability.ts`.
 */

import { useRef, useState } from "react";
import { PlaceholderInput } from "@/ui/PlaceholderInput";
import { pushToast } from "@/ui/Toast";
import { useAvatarUploadConfigured } from "@/core/avatar/availability";
import { uploadAvatarImage } from "@/core/avatar/upload";
import { fileFromClipboard, isFileDrag, matchesAccept } from "@/lib/fileUpload";
import type { PlaceholderGroup } from "@/core/plugins/placeholders";
import styles from "./AvatarField.module.css";

interface AvatarFieldProps {
  /** Control id handed down by `Field` — must land on the text input. */
  id: string;
  value: string;
  onChange(next: string): void;
  placeholders?: PlaceholderGroup[];
}

export function AvatarField({ id, value, onChange, placeholders }: AvatarFieldProps) {
  const canUpload = useAvatarUploadConfigured();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // One in-flight upload at a time, and a late reply from a superseded upload
  // must never overwrite a newer value. The generation counter is what makes
  // "pick A, immediately pick B" resolve to B rather than to whichever request
  // happened to finish last.
  const generation = useRef(0);

  const handlePick = async (file: File | null) => {
    if (!file) return;
    if (!matchesAccept(file, "image/*")) {
      pushToast(`“${file.name}” isn't an image file.`, "error");
      return;
    }
    const mine = ++generation.current;
    setBusy(true);
    const result = await uploadAvatarImage(file);
    if (mine !== generation.current) return; // superseded by a later pick
    setBusy(false);
    if (result.ok) onChange(result.url);
    else pushToast(result.error, "error");
  };

  // Paste-to-upload while the field is focused. Scoped to this element (unlike
  // `AttachmentPicker`, which listens on the document) because the avatar field
  // shares the page with the whole editor — a document listener here would
  // steal every screenshot paste aimed at a component.
  const handlePaste = (e: React.ClipboardEvent) => {
    if (!canUpload || !e.clipboardData) return;
    const file = fileFromClipboard(e.clipboardData);
    if (!file) return;
    e.preventDefault();
    void handlePick(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (!canUpload || !isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!dragOver) setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    if (!canUpload || !isFileDrag(e)) return;
    e.preventDefault();
    setDragOver(false);
    void handlePick(e.dataTransfer.files?.[0] ?? null);
  };

  return (
    <div
      className={styles.row}
      onDragEnter={handleDragOver}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onPaste={handlePaste}
    >
      <PlaceholderInput
        id={id}
        className={canUpload ? styles.inputWithButton : undefined}
        data-meta-field="avatar"
        type="url"
        value={value}
        placeholders={placeholders}
        onChange={onChange}
        placeholder="https://… or {server_icon}"
      />

      {canUpload ? (
        <>
          <button
            type="button"
            className={styles.uploadBtn}
            disabled={busy}
            aria-busy={busy}
            onClick={() => inputRef.current?.click()}
          >
            {busy ? <span className={styles.spinnerDot} aria-hidden="true" /> : "Upload"}
            {busy ? <span className={styles.srOnly}>Uploading</span> : null}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className={styles.fileInput}
            onChange={(e) => {
              const file = e.currentTarget.files?.[0] ?? null;
              // Clear the input so re-picking the same file fires `change`.
              e.currentTarget.value = "";
              void handlePick(file);
            }}
          />
        </>
      ) : null}

      {dragOver ? (
        <span className={styles.dropOverlay} aria-hidden="true">
          Drop image here
        </span>
      ) : null}
    </div>
  );
}
