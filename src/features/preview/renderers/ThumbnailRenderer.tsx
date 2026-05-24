import type { ThumbnailComponent } from "@/core/schema/types";
import { cn } from "@/lib/cn";
import styles from "./ThumbnailRenderer.module.css";

export function ThumbnailRenderer({ node }: { node: ThumbnailComponent }) {
  return (
    <div className={cn(styles.thumb, node.spoiler && styles.spoiler)}>
      <img
        src={node.media.url}
        alt={node.description || ""}
        loading="lazy"
        decoding="async"
      />
    </div>
  );
}
