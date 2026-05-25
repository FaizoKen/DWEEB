import type { FileComponent } from "@/core/schema/types";
import { cn } from "@/lib/cn";
import { parseSessionUrl } from "@/core/state/attachmentStore";
import { useResolvedMediaUrl } from "./useResolvedMediaUrl";
import styles from "./FileRenderer.module.css";

export function FileRenderer({ node }: { node: FileComponent }) {
  const url = node.file.url ?? "";
  const attachmentId = node.file.attachment_id;
  const session = parseSessionUrl(url);
  const resolved = useResolvedMediaUrl(url);

  const filename = session
    ? session.filename
    : url.startsWith("attachment://")
      ? url.slice("attachment://".length)
      : url
        ? url.split("/").pop() || url
        : attachmentId
          ? `Attachment ${attachmentId.slice(-6)}`
          : "(no source)";

  const subtitle = session
    ? resolved
      ? "Will upload on send"
      : "Re-attach before sending"
    : url.startsWith("attachment://")
      ? "Webhook attachment"
      : url
        ? "External file"
        : attachmentId
          ? "Attachment by id"
          : "Needs a URL or attachment id";

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
        <div className={styles.sub}>{subtitle}</div>
      </div>
    </div>
  );
}
