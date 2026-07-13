/**
 * Garbage-collects file blobs once they're no longer referenced by any
 * component. We can't tie blob lifetime directly to component removal because
 * nodes can be duplicated, copied between containers, or moved around — so a
 * "delete this node" path can't safely free the blob without checking the rest
 * of the tree.
 *
 * Cheap alternative: after every message/history/browser-save mutation, walk
 * the live tree, every undo/redo snapshot, and every named browser draft, then
 * tell the registry which blob ids are still reachable. Anything else gets
 * freed (from both the in-memory map and IndexedDB). History is part of the
 * root set because deleting a component pushes its old tree onto `past`;
 * browser saves are roots because loading one later must restore its files.
 *
 * On mount we first `hydrateAttachments()` — pulling persisted uploads back
 * into the registry so the draft's `session://` URLs resolve again — then run
 * the reconcile pass once. That ordering matters: GC removes any restored blob
 * the current tree no longer references (e.g. the draft was replaced by an
 * import), evicting it from IndexedDB too. Running GC before hydration would
 * see an empty map and free nothing.
 */

import { useEffect } from "react";
import { useMessageStore, type MessageState } from "@/core/state/messageStore";
import { useSavedMessagesStore, type SavedMessageRecord } from "@/core/state/savedMessagesStore";
import { garbageCollect, hydrateAttachments } from "@/core/state/attachmentStore";
import { ComponentType, type WebhookMessage } from "@/core/schema/types";

export function useAttachmentGc(): void {
  useEffect(() => {
    let cancelled = false;
    const reconcile = () =>
      garbageCollect(
        collectReferencedMediaUrls(
          useMessageStore.getState(),
          useSavedMessagesStore.getState().entries,
        ),
      );
    void hydrateAttachments().then(() => {
      if (cancelled) return;
      reconcile();
    });
    const unsubscribeMessage = useMessageStore.subscribe((state, prev) => {
      if (
        state.message === prev.message &&
        state.past === prev.past &&
        state.future === prev.future
      ) {
        return;
      }
      reconcile();
    });
    const unsubscribeSaved = useSavedMessagesStore.subscribe((state, prev) => {
      if (state.entries !== prev.entries) reconcile();
    });
    return () => {
      cancelled = true;
      unsubscribeMessage();
      unsubscribeSaved();
    };
  }, []);
}

/**
 * Every message snapshot the user can currently reach. Exported so the
 * delete -> Undo contract can be pinned without mounting the React hook.
 *
 * Persisted history is deliberately included after reload too: messageStore
 * hydrates `past`/`future` before this hook runs, so IndexedDB bytes remain
 * available for every history frame that survived historyStorage's caps.
 */
export function* collectReferencedMediaUrls(
  state: Pick<MessageState, "message" | "past" | "future">,
  savedMessages: readonly Pick<SavedMessageRecord, "payload">[] = [],
): Generator<string> {
  yield* collectMediaUrls(state.message);
  for (const frame of state.past) yield* collectMediaUrls(frame.message);
  for (const frame of state.future) yield* collectMediaUrls(frame.message);
  for (const saved of savedMessages) yield* collectMediaUrls(saved.payload);
}

function* collectMediaUrls(message: WebhookMessage | unknown): Generator<string> {
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
  if (!message || typeof message !== "object") return;
  const components = (message as { components?: unknown }).components;
  if (!Array.isArray(components)) return;
  for (const top of components) yield* visit(top);
}
