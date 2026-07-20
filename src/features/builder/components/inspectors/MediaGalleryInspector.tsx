import { useEffect, useId, useRef } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { addThenScroll } from "@/features/builder/scrollTreeRow";
import { LIMITS } from "@/core/schema/limits";
import { ComponentType, type MediaGalleryComponent } from "@/core/schema/types";
import { filesFromClipboard, matchesAccept } from "@/lib/fileUpload";
import { cn } from "@/lib/cn";
import { pushToast } from "@/ui/Toast";
import { useFileDrop } from "../useFileDrop";
import { addFilesToGallery } from "../galleryUpload";
import styles from "./inspectors.module.css";

interface Props {
  node: MediaGalleryComponent;
}

const GALLERY_ACCEPT = "image/*,video/*";

export function MediaGalleryInspector({ node }: Props) {
  const addItem = useMessageStore((s) => s.addGalleryItem);
  const fileInputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const isFull = node.items.length >= LIMITS.GALLERY_ITEMS;

  // Capture the live item count for the paste listener so it stays correct
  // without re-subscribing on every add.
  const countRef = useRef(node.items.length);
  countRef.current = node.items.length;

  const { isDragOver, handlers } = useFileDrop({
    accept: GALLERY_ACCEPT,
    multiple: true,
    enabled: !isFull,
    onFiles: (files) => addFilesToGallery(node._id, countRef.current, files),
    onReject: () => pushToast("Only images and videos can be added here.", "error"),
  });

  // Paste-to-add while this gallery is selected — the inspector is only mounted
  // then, so the listener's lifetime is naturally scoped. Mirrors the
  // AttachmentPicker pattern: pastes carrying no file fall through untouched so
  // text pastes still reach their inputs.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (!e.clipboardData) return;
      const files = filesFromClipboard(e.clipboardData).filter((f) =>
        matchesAccept(f, GALLERY_ACCEPT),
      );
      if (files.length === 0) return;
      e.preventDefault();
      addFilesToGallery(node._id, countRef.current, files);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [node._id]);

  const handlePick = (list: FileList | null) => {
    const files = Array.from(list ?? []).filter((f) => matchesAccept(f, GALLERY_ACCEPT));
    if (files.length > 0) addFilesToGallery(node._id, countRef.current, files);
  };

  return (
    <>
      <div className={styles.listHeader}>
        <span>
          Media ({node.items.length} / {LIMITS.GALLERY_ITEMS})
        </span>
        <button
          type="button"
          className={styles.addItem}
          disabled={isFull}
          onClick={() => addThenScroll(() => addItem(node._id))}
        >
          + Add media
        </button>
      </div>

      <label
        htmlFor={fileInputId}
        className={cn(
          styles.galleryDrop,
          isDragOver && styles.galleryDropActive,
          isFull && styles.galleryDropFull,
        )}
        tabIndex={isFull ? -1 : 0}
        onKeyDown={(e) => {
          if (!isFull && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        {...handlers}
      >
        <input
          ref={inputRef}
          id={fileInputId}
          type="file"
          accept={GALLERY_ACCEPT}
          multiple
          tabIndex={-1}
          className={styles.galleryDropInput}
          disabled={isFull}
          onChange={(e) => {
            handlePick(e.currentTarget.files);
            // Reset so picking the same file again still fires onChange.
            e.currentTarget.value = "";
          }}
        />
        {isFull ? (
          <span>Gallery full — {LIMITS.GALLERY_ITEMS} items max.</span>
        ) : (
          <>
            <strong>Drag &amp; drop, paste, or click to add images or videos</strong>
            <span>Kept in this browser while editing; uploaded to Discord when you send.</span>
          </>
        )}
      </label>

      <p className={styles.note}>
        Each item is its own row in the tree below — select a row to edit it, or use its up/down
        arrows to reorder.
      </p>

      <p className={styles.note}>
        This gallery sits at type <code>{ComponentType.MediaGallery}</code> in the wire format.
      </p>
    </>
  );
}
