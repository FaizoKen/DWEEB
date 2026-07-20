/**
 * The webhook "Avatar URL" control: a round preview, the URL input, and an
 * upload button that turns a local image into a permanent public URL.
 *
 * Deliberately still a URL field. Uploading is an *additional* way to fill it,
 * not a replacement mode, because the field has to keep accepting things an
 * upload can't express — an existing CDN link and the `{server_icon}`
 * placeholder, which resolves per-server at send time. So there is no
 * upload/paste toggle: you can always type, and uploading simply writes the
 * resulting URL into the same input.
 *
 * The upload affordance hides itself entirely when the proxy reports the
 * feature off (`avatarUploads` in `/api/capabilities`), leaving precisely the
 * field that existed before. See `core/avatar/availability.ts`.
 */

import { useEffect, useRef, useState } from "react";
import { Button } from "@/ui/Button";
import { PlaceholderInput } from "@/ui/PlaceholderInput";
import { useAvatarUploadConfigured } from "@/core/avatar/availability";
import { uploadAvatarImage } from "@/core/avatar/upload";
import { proxiedMediaUrl } from "@/core/activity/runtime";
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

/** A value we can actually render in the round preview. */
function previewSrc(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // `{server_icon}` and friends only resolve at send time, so there is nothing
  // to show for them — fall back to the empty state rather than a broken image.
  if (trimmed.includes("{")) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  // Inside the Activity the sandbox CSP blocks arbitrary `<img>` hosts, so the
  // thumbnail goes through the proxy exactly like the preview's avatar does.
  return proxiedMediaUrl(trimmed);
}

export function AvatarField({ id, value, onChange, placeholders }: AvatarFieldProps) {
  const canUpload = useAvatarUploadConfigured();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [broken, setBroken] = useState(false);

  const src = previewSrc(value);

  // A new URL deserves a fresh chance to load; without this the broken flag
  // from a previous bad value would stick to a good one.
  useEffect(() => {
    setBroken(false);
  }, [src]);

  // One in-flight upload at a time, and a late reply from a superseded upload
  // must never overwrite a newer value. The generation counter is what makes
  // "pick A, immediately pick B" resolve to B rather than to whichever request
  // happened to finish last.
  const generation = useRef(0);

  const handlePick = async (file: File | null) => {
    if (!file) return;
    if (!matchesAccept(file, "image/*")) {
      setError(`“${file.name}” isn't an image file.`);
      return;
    }
    const mine = ++generation.current;
    setError(null);
    setBusy(true);
    const result = await uploadAvatarImage(file);
    if (mine !== generation.current) return; // superseded by a later pick
    setBusy(false);
    if (result.ok) onChange(result.url);
    else setError(result.error);
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
    <div className={styles.wrap}>
      <div
        className={styles.row}
        onDragEnter={handleDragOver}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onPaste={handlePaste}
      >
        <span className={styles.preview}>
          {src && !broken ? (
            <img
              className={styles.previewImg}
              src={src}
              alt=""
              onError={() => setBroken(true)}
              onLoad={() => setBroken(false)}
            />
          ) : (
            <span className={styles.previewEmpty} aria-hidden="true">
              <PersonIcon />
            </span>
          )}
          {busy ? (
            <span className={styles.spinner}>
              <span className={styles.spinnerDot} />
            </span>
          ) : null}
        </span>

        <PlaceholderInput
          id={id}
          className={styles.input}
          data-meta-field="avatar"
          type="url"
          value={value}
          placeholders={placeholders}
          onChange={onChange}
          placeholder="https://… or {server_icon}"
        />

        {canUpload ? (
          <>
            <Button
              variant="secondary"
              size="sm"
              className={styles.uploadBtn}
              disabled={busy}
              onClick={() => inputRef.current?.click()}
            >
              {busy ? "Uploading…" : "Upload"}
            </Button>
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

      {error ? (
        <p className={styles.errorText} role="alert">
          {error}
        </p>
      ) : canUpload ? (
        <p className={styles.status}>Upload, drop, or paste an image — it’s cropped to a square.</p>
      ) : null}
    </div>
  );
}

function PersonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="8.5" r="3.5" fill="currentColor" />
      <path
        d="M4.5 20c0-3.6 3.4-6 7.5-6s7.5 2.4 7.5 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
