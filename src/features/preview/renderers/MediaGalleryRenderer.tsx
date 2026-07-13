/**
 * Media gallery. Discord's grid behavior depends on item count:
 *  1     → single full-width image (max height ~300)
 *  2     → two columns
 *  3     → 2-column grid, first item spans both rows
 *  4     → 2-column grid
 *  5     → 2 wide cells on top, 3 narrower cells below
 *  6,9   → 3-column grid (clean rows)
 *  7,10  → first item is a full-width hero, remainder in a 3-column grid
 *  8     → 2 wide cells on top, then two rows of 3 narrower cells below
 * We approximate that layout via CSS grid + a data-count attribute.
 */

import type { EditorId, MediaGalleryComponent, MediaGalleryItem } from "@/core/schema/types";
import { useMessageStore } from "@/core/state/messageStore";
import { useAiStore } from "@/core/ai/aiStore";
import { cn } from "@/lib/cn";
import { usePreviewClose } from "../previewCloseContext";
import { useResolvedMediaUrl } from "./useResolvedMediaUrl";
import { mediaKindFromName, mediaNameFromUrl } from "./mediaKind";
import styles from "./MediaGalleryRenderer.module.css";

export function MediaGalleryRenderer({ node }: { node: MediaGalleryComponent }) {
  const count = node.items.length;
  const select = useMessageStore((s) => s.select);
  const selectedId = useMessageStore((s) => s.selectedId);
  const closePreview = usePreviewClose();

  if (count === 0) return null;

  // Clicking a specific image selects that image's tree row (each gallery item
  // is its own row now), then scrolls the builder to it. stopPropagation in the
  // figure keeps the wrapper from also selecting the whole gallery.
  const handlePick = (itemId: EditorId, revealingSpoiler: boolean, focusTreeRow: boolean) => {
    select(itemId);
    // Mirror ComponentRenderer: dismiss the mobile preview slide-over so the
    // editor becomes visible, but keep it open while the AI chat is active —
    // or while this tap is just revealing a spoiler the user wants to see.
    if (!revealingSpoiler && !useAiStore.getState().open) closePreview?.();
    requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(
        `[data-tree-row="true"][data-row-id="${CSS.escape(itemId)}"]`,
      );
      row?.scrollIntoView({ behavior: "smooth", block: "start" });
      if (focusTreeRow) {
        row
          ?.querySelector<HTMLButtonElement>("[data-row-select='true']")
          ?.focus({ preventScroll: true });
      }
    });
  };

  return (
    <div className={styles.gallery} data-count={String(Math.min(count, 10))}>
      {node.items.map((item) => (
        <GalleryItem
          key={item._id}
          item={item}
          selected={selectedId === item._id}
          onPick={(focusTreeRow) =>
            handlePick(item._id, item.spoiler === true && selectedId !== item._id, focusTreeRow)
          }
        />
      ))}
    </div>
  );
}

function GalleryItem({
  item,
  selected,
  onPick,
}: {
  item: MediaGalleryItem;
  selected: boolean;
  onPick: (focusTreeRow: boolean) => void;
}) {
  // Reveal follows the editor selection: clicking the item selects it (which
  // reveals it), and selecting another item/node re-blurs this one.
  const obscured = item.spoiler === true && !selected;
  const url = item.media.url ?? "";
  const src = useResolvedMediaUrl(url);
  const usesAttachmentId = !item.media.url && typeof item.media.attachment_id === "string";
  const hasAlt = Boolean(item.description);
  // Galleries accept video items too — render a <video> for those so an mp4
  // doesn't paint as a broken <img>. Default to image when the kind is unknown.
  const kind = src ? mediaKindFromName(mediaNameFromUrl(url), item.media.content_type) : null;
  return (
    <figure
      // Lets the tree→preview scroll (and the editor selection highlight) target
      // this exact image, mirroring the `data-node-id` on component wrappers.
      data-node-id={item._id}
      className={cn(
        styles.item,
        styles.clickable,
        selected && styles.selectedItem,
        obscured && styles.spoiler,
      )}
      title={item.description}
      role="button"
      tabIndex={0}
      aria-label={`${item.description ? `${item.description}. ` : ""}Press Enter to edit this gallery item.`}
      onClick={(e) => {
        e.stopPropagation();
        onPick(false);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        onPick(true);
      }}
    >
      {src ? (
        kind === "video" ? (
          <video src={src} muted playsInline preload="metadata" />
        ) : (
          <img
            src={src}
            alt={item.description || ""}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
          />
        )
      ) : (
        <div className={styles.placeholder} aria-label="Attachment will be uploaded on send">
          {usesAttachmentId ? "Resolved on send" : "Will upload on send"}
        </div>
      )}
      {kind === "video" && src && (
        // Discord overlays a play button on gallery video items; mirror it.
        <span className={styles.playButton} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        </span>
      )}
      {hasAlt && src && (
        // Discord pins the ALT badge top-left on video items (the play button
        // occupies the center, the bottom edge reads as scrubber territory).
        <span className={cn(styles.altBadge, kind === "video" && styles.altBadgeTop)}>ALT</span>
      )}
      {obscured && src && (
        // Discord obscures spoilered media behind a heavy blur and a centered
        // "SPOILER" pill until it's revealed; hovering (desktop) or tapping
        // (touch) clears the blur and the pill.
        <span className={styles.spoilerPill} aria-hidden="true">
          Spoiler
        </span>
      )}
    </figure>
  );
}
