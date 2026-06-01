import type { ThumbnailComponent } from "@/core/schema/types";
import { useMessageStore } from "@/core/state/messageStore";
import { cn } from "@/lib/cn";
import { useResolvedMediaUrl } from "./useResolvedMediaUrl";
import styles from "./ThumbnailRenderer.module.css";

export function ThumbnailRenderer({ node }: { node: ThumbnailComponent }) {
  // Reveal follows the editor selection: clicking the thumbnail selects it
  // (which reveals it), and selecting anything else re-blurs it.
  const selectedId = useMessageStore((s) => s.selectedId);
  const obscured = node.spoiler === true && selectedId !== node._id;
  const src = useResolvedMediaUrl(node.media.url ?? "");
  const usesAttachmentId = !node.media.url && typeof node.media.attachment_id === "string";
  const hasAlt = Boolean(node.description);
  return (
    <div className={cn(styles.thumb, obscured && styles.spoiler)}>
      {src ? (
        <img src={src} alt={node.description || ""} loading="lazy" decoding="async" />
      ) : (
        <div className={styles.placeholder}>
          {usesAttachmentId ? "Resolved on send" : "Will upload on send"}
        </div>
      )}
      {hasAlt && src && <span className={styles.altBadge}>ALT</span>}
      {obscured && src && (
        <span className={styles.spoilerPill} aria-hidden="true">
          Spoiler
        </span>
      )}
    </div>
  );
}
