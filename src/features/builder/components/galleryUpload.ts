/**
 * Shared "drop / paste files into a gallery" actions, used by the gallery tree
 * row, its image rows, and the gallery inspector so they all clamp to the cap
 * and surface the same messaging.
 *
 * Files are registered in the attachment store (persisted to IndexedDB) and
 * handed to the message store. Plain functions rather than hooks so any of
 * those surfaces — including a document-level paste listener — can call them.
 */

import { LIMITS } from "@/core/schema/limits";
import { registerAttachment } from "@/core/state/attachmentStore";
import { useMessageStore } from "@/core/state/messageStore";
import type { EditorId } from "@/core/schema/types";
import { pushToast } from "@/ui/Toast";

/** Append dropped/pasted files as new gallery images (gallery row / inspector). */
export function addFilesToGallery(galleryId: EditorId, currentCount: number, files: File[]): void {
  if (files.length === 0) return;
  const room = LIMITS.GALLERY_ITEMS - currentCount;
  if (room <= 0) {
    pushToast(`Gallery is full — ${LIMITS.GALLERY_ITEMS} images max.`, "error");
    return;
  }
  const accepted = files.slice(0, room);
  const urls = accepted.map((file) => registerAttachment(file));
  useMessageStore.getState().addGalleryItemsWithUrls(galleryId, urls);
  if (files.length > room) {
    pushToast(
      `Added ${accepted.length} — galleries hold up to ${LIMITS.GALLERY_ITEMS} images.`,
      "info",
    );
  }
}

/**
 * Replace one gallery image with a dropped/pasted file (dropping onto its
 * row / inspector picker). The first file takes over the targeted slot in
 * place — keeping its alt text and spoiler flag — and any extra files are
 * inserted right after it, clamped to the cap.
 */
export function replaceGalleryItemFiles(
  galleryId: EditorId,
  itemId: EditorId,
  currentCount: number,
  files: File[],
): void {
  if (files.length === 0) return;
  // The replacement is in place (count unchanged); only the *extra* files need
  // room under the cap.
  const roomForExtras = Math.max(0, LIMITS.GALLERY_ITEMS - currentCount);
  const kept = files.slice(0, 1 + roomForExtras);
  const urls = kept.map((file) => registerAttachment(file));
  useMessageStore.getState().replaceGalleryItemWithUrls(galleryId, itemId, urls);
  if (files.length > kept.length) {
    pushToast(`Replaced 1 — galleries hold up to ${LIMITS.GALLERY_ITEMS} images.`, "info");
  }
}
