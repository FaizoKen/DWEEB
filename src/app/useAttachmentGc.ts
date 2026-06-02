/**
 * Garbage-collects file blobs once they're no longer referenced by any
 * component. We can't tie blob lifetime directly to component removal because
 * nodes can be duplicated, copied between containers, or moved around — so a
 * "delete this node" path can't safely free the blob without checking the rest
 * of the tree.
 *
 * Cheap alternative: after every message mutation, walk the tree and tell the
 * registry which blob ids are still in use. Anything else gets freed (from both
 * the in-memory map and IndexedDB).
 *
 * On mount we first `hydrateAttachments()` — pulling persisted uploads back
 * into the registry so the draft's `session://` URLs resolve again — then run
 * the reconcile pass once. That ordering matters: GC removes any restored blob
 * the current tree no longer references (e.g. the draft was replaced by an
 * import), evicting it from IndexedDB too. Running GC before hydration would
 * see an empty map and free nothing.
 */

import { useEffect } from "react";
import { useMessageStore } from "@/core/state/messageStore";
import { garbageCollect, hydrateAttachments } from "@/core/state/attachmentStore";
import { ComponentType, type WebhookMessage } from "@/core/schema/types";

export function useAttachmentGc(): void {
  useEffect(() => {
    let cancelled = false;
    void hydrateAttachments().then(() => {
      if (cancelled) return;
      garbageCollect(collectMediaUrls(useMessageStore.getState().message));
    });
    const unsubscribe = useMessageStore.subscribe((state, prev) => {
      if (state.message === prev.message) return;
      garbageCollect(collectMediaUrls(state.message));
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
}

function* collectMediaUrls(message: WebhookMessage): Generator<string> {
  const visit = function* (node: unknown): Generator<string> {
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const type = typeof obj.type === "number" ? obj.type : null;
    if (type === ComponentType.File) {
      const file = obj.file as { url?: unknown } | undefined;
      if (file && typeof file.url === "string") yield file.url;
    } else if (type === ComponentType.Thumbnail) {
      const media = obj.media as { url?: unknown } | undefined;
      if (media && typeof media.url === "string") yield media.url;
    } else if (type === ComponentType.MediaGallery) {
      const items = obj.items;
      if (Array.isArray(items)) {
        for (const item of items) {
          const media = (item as { media?: { url?: unknown } })?.media;
          if (media && typeof media.url === "string") yield media.url;
        }
      }
    }
    if (Array.isArray(obj.components)) {
      for (const child of obj.components) yield* visit(child);
    }
    if (obj.accessory) yield* visit(obj.accessory);
  };
  for (const top of message.components) yield* visit(top);
}
