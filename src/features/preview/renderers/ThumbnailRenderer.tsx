import type { ThumbnailComponent } from "@/core/schema/types";
import { cn } from "@/lib/cn";
import { useResolvedMediaUrl } from "./useResolvedMediaUrl";
import styles from "./ThumbnailRenderer.module.css";

export function ThumbnailRenderer({ node }: { node: ThumbnailComponent }) {
  const src = useResolvedMediaUrl(node.media.url ?? "");
  const usesAttachmentId =
    !node.media.url && typeof node.media.attachment_id === "string";
  const hasAlt = Boolean(node.description);
  return (
    <div className={cn(styles.thumb, node.spoiler && styles.spoiler)}>
      {src ? (
        <img src={src} alt={node.description || ""} loading="lazy" decoding="async" />
      ) : (
        <div className={styles.placeholder}>
          {usesAttachmentId ? "Resolved on send" : "Will upload on send"}
        </div>
      )}
      {hasAlt && src && <span className={styles.altBadge}>ALT</span>}
    </div>
  );
}
