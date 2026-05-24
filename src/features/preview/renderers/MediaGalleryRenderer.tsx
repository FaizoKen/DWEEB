/**
 * Media gallery. Discord's grid behavior depends on item count:
 *  1   → single full-width image (max height ~300)
 *  2   → two columns
 *  3-4 → 2-column grid with the last item spanning when count is odd
 *  5+  → 3-column grid
 * We approximate that layout via CSS grid + a data-count attribute.
 */

import type { MediaGalleryComponent } from "@/core/schema/types";
import { cn } from "@/lib/cn";
import styles from "./MediaGalleryRenderer.module.css";

export function MediaGalleryRenderer({ node }: { node: MediaGalleryComponent }) {
  const count = node.items.length;
  if (count === 0) return null;
  return (
    <div className={styles.gallery} data-count={String(Math.min(count, 5))}>
      {node.items.map((item, i) => (
        <figure
          key={i}
          className={cn(styles.item, item.spoiler && styles.spoiler)}
          title={item.description}
        >
          <img
            src={item.media.url}
            alt={item.description || ""}
            loading="lazy"
            decoding="async"
          />
        </figure>
      ))}
    </div>
  );
}
