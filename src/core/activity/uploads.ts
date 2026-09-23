/**
 * Uploads this browser can't send.
 *
 * A file uploaded in the editor lives only in the browser it was uploaded from:
 * the draft holds a `session://<blob>/<name>` reference, and the bytes sit in
 * this page's attachment registry (see `core/state/attachmentStore`). In the
 * Activity the shared draft carries those references to everyone in the room,
 * so a collaborator's upload — or one made before DWEEB was reopened (the
 * Activity keeps no uploads across launches) — is referenced but absent here.
 * Posting from here would have to leave it out, so post/update refuse with a
 * message that names the way out instead of letting Discord reject a dangling
 * attachment.
 */

import { useMemo, useSyncExternalStore } from "react";
import type { WebhookMessage } from "@/core/schema/types";
import {
  getAttachmentFile,
  getAttachmentSnapshot,
  parseSessionUrl,
  subscribeAttachments,
} from "@/core/state/attachmentStore";
import { useMessageStore } from "@/core/state/messageStore";

/** Whether this browser holds the bytes behind an upload's blob id. */
const heldHere = (blobId: string): boolean => getAttachmentFile(blobId) !== null;

/**
 * How many distinct uploads the draft references that this browser doesn't
 * hold. Only media `url` fields count (the same rule `hasSessionAttachments`
 * applies), so text that merely mentions `session://` is never mistaken for one.
 */
export function missingUploadCount(
  message: WebhookMessage,
  isHeld: (blobId: string) => boolean = heldHere,
): number {
  const missing = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
      if (key === "url" && typeof field === "string") {
        const session = parseSessionUrl(field);
        if (session && !isHeld(session.blobId)) missing.add(session.blobId);
      } else if (field && typeof field === "object") {
        visit(field);
      }
    }
  };
  visit(message);
  return missing.size;
}

/** Why a post can't go out while `count` uploads are missing here. Doesn't
 *  claim whose device they're on — a teammate's, or this one before a relaunch
 *  — only what's true: they aren't in this browser. */
export function missingUploadsMessage(count: number): string {
  return count === 1
    ? "An uploaded file in this draft isn't in this browser, so it can't be posted from here — if a teammate added it, ask them to post; otherwise re-attach it or use a media URL."
    : `${count} uploaded files in this draft aren't in this browser, so they can't be posted from here — if a teammate added them, ask them to post; otherwise re-attach them or use media URLs.`;
}

/** Live {@link missingUploadCount} for the current draft — recomputed when the
 *  draft changes or an upload is registered here. */
export function useMissingUploadCount(): number {
  const message = useMessageStore((s) => s.message);
  const version = useSyncExternalStore(
    subscribeAttachments,
    getAttachmentSnapshot,
    getAttachmentSnapshot,
  );
  // `version` isn't read in the body — it's the invalidation key for a registry
  // change, which the message alone doesn't reflect.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => missingUploadCount(message), [message, version]);
}
