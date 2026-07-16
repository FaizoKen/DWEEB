import { useState } from "react";
import type { ThumbnailComponent } from "@/core/schema/types";
import { useMessageStore } from "@/core/state/messageStore";
import { cn } from "@/lib/cn";
import { BrokenImageIcon } from "./BrokenImageIcon";
import { useResolvedMediaUrl } from "./useResolvedMediaUrl";
import styles from "./ThumbnailRenderer.module.css";
import { usePreviewMediaPriority } from "../mediaPriorityContext";

export function ThumbnailRenderer({ node }: { node: ThumbnailComponent }) {
  // Reveal follows the editor selection: clicking the thumbnail selects it
  // (which reveals it), and selecting anything else re-blurs it.
  const selectedId = useMessageStore((s) => s.selectedId);
  const obscured = node.spoiler === true && selectedId !== node._id;
  const url = node.media.url ?? "";
  const src = useResolvedMediaUrl(url);
  const priority = usePreviewMediaPriority(url);
  const [failed, setFailed] = useState(false);
  // A cached broken image can be `complete` (with zero natural size) before
  // the error listener attaches — check the element's state on mount too.
  const readImageState = (el: HTMLImageElement | null) => {
    if (el && el.complete && el.naturalWidth === 0 && el.currentSrc) setFailed(true);
  };
  const usesAttachmentId = !node.media.url && typeof node.media.attachment_id === "string";
  const hasAlt = Boolean(node.description);
  return (
    <div className={cn(styles.thumb, obscured && styles.spoiler)}>
      {src && failed ? (
        // Discord's failed-thumbnail treatment: the 85px box stays, with a
        // centered broken-image glyph.
        <div className={styles.notFound} role="img" aria-label="Image failed to load">
          <BrokenImageIcon />
        </div>
      ) : src ? (
        <img
          ref={readImageState}
          src={src}
          alt={node.description || ""}
          loading={priority ? "eager" : "lazy"}
          fetchPriority={priority ? "high" : "auto"}
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          onLoad={() => setFailed(false)}
        />
      ) : (
        <div className={styles.placeholder}>
          {usesAttachmentId ? "Resolved on send" : "Will upload on send"}
        </div>
      )}
      {hasAlt && src && !failed && <span className={styles.altBadge}>ALT</span>}
      {obscured && src && (
        <span className={styles.spoilerPill} aria-hidden="true">
          Spoiler
        </span>
      )}
    </div>
  );
}
