/**
 * Hook that resolves a stored media URL into something the browser can
 * actually render. Used by every preview renderer that paints media.
 *
 *  - `session://<id>/<name>` → object URL for the in-memory blob, or null when
 *    the blob has been GC'd (so callers can show a placeholder).
 *  - `attachment://<filename>` → null (no preview source available — the file
 *    only exists on Discord's CDN once the message is posted).
 *  - everything else → returned unchanged.
 */

import { useSyncExternalStore } from "react";
import {
  getAttachmentObjectUrl,
  getAttachmentSnapshot,
  parseSessionUrl,
  subscribeAttachments,
} from "@/core/state/attachmentStore";

export function useResolvedMediaUrl(url: string): string | null {
  useSyncExternalStore(subscribeAttachments, getAttachmentSnapshot, getAttachmentSnapshot);
  const session = parseSessionUrl(url);
  if (session) return getAttachmentObjectUrl(session.blobId);
  if (url.startsWith("attachment://")) return null;
  return url;
}
