/**
 * React hook bridging the attachment registry to component state.
 *
 * The registry lives outside React (so non-React code — e.g. the wire-payload
 * builder — can read it without going through a hook). `useSyncExternalStore`
 * lets us subscribe to mutation notifications so that, e.g., picking a file
 * in the inspector immediately re-renders previews that point at the same id.
 */

import { useSyncExternalStore } from "react";
import {
  getAttachmentFile,
  getAttachmentObjectUrl,
  getAttachmentSnapshot,
  subscribeAttachments,
} from "@/core/state/attachmentStore";

export interface AttachmentRecord {
  file: File;
  /** Lazy preview URL — only call when actually rendering. */
  objectUrl: string;
}

/** Subscribe to a single blob id. Returns null when the blob isn't present. */
export function useAttachmentRecord(blobId: string | null): AttachmentRecord | null {
  // We subscribe to the whole registry (cheap — listeners only fire on
  // add/remove). The snapshot reference is stable per change so React's
  // shallow check on the returned value works correctly.
  useSyncExternalStore(subscribeAttachments, getAttachmentSnapshot, getAttachmentSnapshot);
  if (!blobId) return null;
  const file = getAttachmentFile(blobId);
  if (!file) return null;
  const objectUrl = getAttachmentObjectUrl(blobId);
  if (!objectUrl) return null;
  return { file, objectUrl };
}
