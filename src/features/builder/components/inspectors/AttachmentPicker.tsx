/**
 * Shared upload control for any media-bearing field (File / Thumbnail /
 * MediaGalleryItem). Lets the user either pick a local file (held in the
 * in-memory attachment registry) or paste any URL; the owning inspector
 * stays in charge of the field shape and patching.
 *
 * The picker is intentionally stateless w.r.t. the actual blob — it reads
 * the current URL prop and writes back via `onChange`. Whether the URL is
 * a public https://, a Discord `attachment://`, or our internal
 * `session://<id>/<name>` ref is opaque to the picker; resolution to a
 * preview source lives in the renderers.
 */

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/ui/Button";
import { isSessionUrl, parseSessionUrl, registerAttachment } from "@/core/state/attachmentStore";
import { useAttachmentRecord } from "./useAttachmentRecord";
import styles from "./AttachmentPicker.module.css";

interface AttachmentPickerProps {
  url: string;
  onChange(next: string): void;
  /** Restrict the file picker's accept list (e.g. "image/*"). */
  accept?: string;
}

export function AttachmentPicker({ url, onChange, accept }: AttachmentPickerProps) {
  const fileInputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const session = isSessionUrl(url) ? parseSessionUrl(url) : null;
  const record = useAttachmentRecord(session?.blobId ?? null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePick = (file: File | null) => {
    if (!file) return;
    // The native `accept` only filters the OS dialog; drag-and-drop and the
    // dialog's "All files" override both slip past it, so re-check here.
    if (!matchesAccept(file, accept)) {
      setError(
        accept?.startsWith("image")
          ? `“${file.name}” isn't an image file.`
          : `“${file.name}” isn't a supported file type.`,
      );
      return;
    }
    setError(null);
    // The previous blob (if any) is left for the post-edit garbage collector
    // to reap — a duplicated component might still reference it.
    const sessionUrl = registerAttachment(file);
    onChange(sessionUrl);
  };

  const handleClear = () => {
    setError(null);
    onChange("");
  };

  // Enter/Space opens the dialog so the focusable dropzone stays keyboard-
  // operable now that there's no separate "Choose file" button.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      inputRef.current?.click();
    }
  };

  // Paste-to-upload. A paste only reaches an element's own onPaste while that
  // element is focused, but users expect Ctrl+V to work right after selecting
  // the component in the tree (focus sits on the tree row, not the dropzone).
  // So we listen at the document level while mounted: only one picker is ever
  // mounted at a time (the inspector edits a single component), and pastes
  // that carry no file are ignored so text pastes still reach their input.
  const handlePickRef = useRef(handlePick);
  useEffect(() => {
    handlePickRef.current = handlePick;
  });
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (!e.clipboardData) return;
      const file = fileFromClipboard(e.clipboardData);
      if (!file) return;
      e.preventDefault();
      handlePickRef.current(file);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  const isFileDrag = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");

  const handleDragOver = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!dragOver) setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    // Ignore leaves that just cross into a child element (e.g. the file input).
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    // Cancel the file input's native drop so we don't double-handle.
    e.preventDefault();
    setDragOver(false);
    handlePick(e.dataTransfer.files?.[0] ?? null);
  };

  const dropText = accept?.startsWith("image") ? "Drop image here" : "Drop file here";

  return (
    <div className={styles.wrap}>
      <label
        htmlFor={fileInputId}
        className={dragOver ? `${styles.dropzone} ${styles.dragging}` : styles.dropzone}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onDragEnter={handleDragOver}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <input
          ref={inputRef}
          id={fileInputId}
          type="file"
          accept={accept}
          tabIndex={-1}
          className={styles.fileInput}
          onChange={(e) => handlePick(e.currentTarget.files?.[0] ?? null)}
        />
        {session ? (
          record ? (
            <div className={styles.fileMeta}>
              <span className={styles.fileName}>{record.file.name}</span>
              <span className={styles.fileSize}>{formatBytes(record.file.size)}</span>
            </div>
          ) : (
            <div className={styles.fileMetaMissing}>
              <span className={styles.fileName}>{session.filename}</span>
              <span className={styles.warningText}>Lost on reload — re-attach to send.</span>
            </div>
          )
        ) : (
          <div className={styles.placeholder}>
            <strong>Drag &amp; drop, paste, or click to upload</strong>
            <span>Held in this browser tab only; never uploaded to a third party.</span>
          </div>
        )}
        {dragOver && (
          <div className={styles.dropOverlay} aria-hidden="true">
            {dropText}
          </div>
        )}
      </label>
      {error ? (
        <p className={styles.errorText} role="alert">
          {error}
        </p>
      ) : null}
      {session ? (
        <div className={styles.actions}>
          <Button variant="secondary" size="sm" onClick={() => inputRef.current?.click()}>
            Replace…
          </Button>
          <Button variant="ghost" size="sm" onClick={handleClear}>
            Remove
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Pull the first file out of a paste. Pasted screenshots arrive as clipboard
 * `items` of kind "file"; copied desktop files populate `files` directly.
 */
function fileFromClipboard(data: DataTransfer): File | null {
  if (data.files && data.files.length > 0) return data.files[0];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === "file") {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}

/**
 * Mirror the browser's `accept` matching so dropped / overridden files obey
 * the same allow-list as the dialog. An empty `accept` permits anything.
 * Tokens may be extensions (".png"), wildcard mimes ("image/*"), or exact
 * mimes ("image/png").
 */
function matchesAccept(file: File, accept: string | undefined): boolean {
  if (!accept) return true;
  const tokens = accept
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return true;
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  return tokens.some((token) => {
    if (token.startsWith(".")) return name.endsWith(token);
    if (token.endsWith("/*")) return type.startsWith(token.slice(0, -1));
    return type === token;
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
