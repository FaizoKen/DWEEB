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

import type { MediaGalleryComponent, MediaGalleryItem } from "@/core/schema/types";
import { cn } from "@/lib/cn";
import { useResolvedMediaUrl } from "./useResolvedMediaUrl";
import styles from "./MediaGalleryRenderer.module.css";

export function MediaGalleryRenderer({ node }: { node: MediaGalleryComponent }) {
  const count = node.items.length;
  if (count === 0) return null;
  return (
    <div className={styles.gallery} data-count={String(Math.min(count, 10))}>
      {node.items.map((item, i) => (
        <GalleryItem key={i} item={item} />
      ))}
    </div>
  );
}

function GalleryItem({ item }: { item: MediaGalleryItem }) {
  const src = useResolvedMediaUrl(item.media.url ?? "");
  const usesAttachmentId =
    !item.media.url && typeof item.media.attachment_id === "string";
  const hasAlt = Boolean(item.description);
  return (
    <figure
      className={cn(styles.item, item.spoiler && styles.spoiler)}
      title={item.description}
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
