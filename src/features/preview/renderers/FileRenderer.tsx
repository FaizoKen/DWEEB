import type { FileComponent } from "@/core/schema/types";
import { cn } from "@/lib/cn";
import styles from "./FileRenderer.module.css";

export function FileRenderer({ node }: { node: FileComponent }) {
  const filename = node.file.url.startsWith("attachment://")
    ? node.file.url.slice("attachment://".length)
    : node.file.url.split("/").pop() || node.file.url;

  return (
    <div className={cn(styles.file, node.spoiler && styles.spoiler)}>
      <div className={styles.icon} aria-hidden="true">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
          <path
            d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9l-6-6z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <path d="M13 3v6h6" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
      </div>
      <div className={styles.body}>
        <div className={styles.name}>{filename}</div>
        <div className={styles.sub}>Webhook attachment</div>
      </div>
    </div>
  );
}
