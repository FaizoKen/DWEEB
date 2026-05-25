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

import { useId, useRef } from "react";
import { Button } from "@/ui/Button";
import {
  isSessionUrl,
  parseSessionUrl,
  registerAttachment,
} from "@/core/state/attachmentStore";
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

  const handlePick = (file: File | null) => {
    if (!file) return;
    // The previous blob (if any) is left for the post-edit garbage collector
    // to reap — a duplicated component might still reference it.
    const sessionUrl = registerAttachment(file);
    onChange(sessionUrl);
  };

  const handleClear = () => {
    onChange("");
  };

  return (
    <div className={styles.wrap}>
      <label htmlFor={fileInputId} className={styles.dropzone}>
        <input
          ref={inputRef}
          id={fileInputId}
          type="file"
          accept={accept}
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
              <span className={styles.warningText}>
                Lost on reload — re-attach to send.
              </span>
            </div>
          )
        ) : (
          <div className={styles.placeholder}>
            <strong>Upload file</strong>
            <span>Held in this browser tab only; never uploaded to a third party.</span>
          </div>
        )}
      </label>
      <div className={styles.actions}>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => inputRef.current?.click()}
        >
          {session ? "Replace…" : "Choose file…"}
        </Button>
        {session ? (
          <Button variant="ghost" size="sm" onClick={handleClear}>
            Remove
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
