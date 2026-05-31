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
  const handlePick = (itemId: EditorId) => {
    select(itemId);
    // Mirror ComponentRenderer: dismiss the mobile preview slide-over so the
    // editor becomes visible, but keep it open while the AI chat is active.
    if (!useAiStore.getState().open) closePreview?.();
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`[data-tree-row="true"][data-row-id="${CSS.escape(itemId)}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  return (
    <div className={styles.gallery} data-count={String(Math.min(count, 10))}>
      {node.items.map((item) => (
        <GalleryItem
          key={item._id}
          item={item}
          selected={selectedId === item._id}
          onPick={() => handlePick(item._id)}
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
  onPick: () => void;
}) {
  const src = useResolvedMediaUrl(item.media.url ?? "");
  const usesAttachmentId = !item.media.url && typeof item.media.attachment_id === "string";
  const hasAlt = Boolean(item.description);
  return (
    <figure
      // Lets the tree→preview scroll (and the editor selection highlight) target
      // this exact image, mirroring the `data-node-id` on component wrappers.
      data-node-id={item._id}
      className={cn(
        styles.item,
        styles.clickable,
        selected && styles.selectedItem,
        item.spoiler && styles.spoiler,
      )}
      title={item.description}
      onClick={(e) => {
        e.stopPropagation();
        onPick();
      }}
    >
      {src ? (
        <img src={src} alt={item.description || ""} loading="lazy" decoding="async" />
      ) : (
        <div className={styles.placeholder} aria-label="Attachment will be uploaded on send">
          {usesAttachmentId ? "Resolved on send" : "Will upload on send"}
        </div>
      )}
      {hasAlt && src && <span className={styles.altBadge}>ALT</span>}
    </figure>
  );
}
