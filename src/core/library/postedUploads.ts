/**
 * Posted history must not point at this browser's storage.
 *
 * An upload in the editor is a `session://<id>/<name>` URL: a handle to bytes
 * only this browser holds. The send turns it into a real upload, but the
 * posted-history record used to keep the handle — so teammates (and this
 * browser, once its attachment cleanup ran) saw a broken preview on the shared
 * Posted shelf, and updating from there meant re-uploading. Discord's echo of
 * the posted message carries each upload's CDN URL in the same place in the
 * component tree, so the record takes that instead; anything the echo doesn't
 * account for is blanked rather than kept as a dangling handle.
 */

import { ComponentType, type WebhookMessage } from "@/core/schema/types";
import { isSessionUrl } from "@/core/state/attachmentStore";

type Obj = Record<string, unknown>;

const asObj = (value: unknown): Obj | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : null;

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The CDN URL the echo gives the media item at this position, if it gives one. */
function echoedUrl(echoMedia: unknown): string {
  const url = asObj(echoMedia)?.url;
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : "";
}

/** A media object (`{ url, … }`) with a session handle swapped for the echo's URL. */
function resolveMedia(media: unknown, echoMedia: unknown): unknown {
  const obj = asObj(media);
  if (!obj || typeof obj.url !== "string" || !isSessionUrl(obj.url)) return media;
  return { ...obj, url: echoedUrl(echoMedia) };
}

function resolveNode(node: unknown, echo: unknown): unknown {
  const obj = asObj(node);
  if (!obj) return node;
  const echoObj = asObj(echo);
  let out: Obj = obj;
  const set = (key: string, value: unknown) => {
    if (value === obj[key]) return;
    if (out === obj) out = { ...obj };
    out[key] = value;
  };
  switch (obj.type) {
    case ComponentType.Thumbnail:
      set("media", resolveMedia(obj.media, echoObj?.media));
      break;
    case ComponentType.File:
      set("file", resolveMedia(obj.file, echoObj?.file));
      break;
    case ComponentType.MediaGallery: {
      const items = asArray(obj.items);
      const echoItems = asArray(echoObj?.items);
      let changed = false;
      const next = items.map((item, i) => {
        const itemObj = asObj(item);
        if (!itemObj) return item;
        const media = resolveMedia(itemObj.media, asObj(echoItems[i])?.media);
        if (media === itemObj.media) return item;
        changed = true;
        return { ...itemObj, media };
      });
      if (changed) set("items", next);
      break;
    }
  }
  if (Array.isArray(obj.components)) {
    const echoChildren = asArray(echoObj?.components);
    let changed = false;
    const next = obj.components.map((child, i) => {
      const resolved = resolveNode(child, echoChildren[i]);
      if (resolved !== child) changed = true;
      return resolved;
    });
    if (changed) set("components", next);
  }
  if (obj.accessory) set("accessory", resolveNode(obj.accessory, echoObj?.accessory));
  return out;
}

/**
 * `message` with every in-session upload replaced by the CDN URL Discord's
 * `echo` of the posted message gives it at the same position (a blank when the
 * echo is missing or says nothing usable). Pure; returns the same object when
 * there is nothing to replace.
 */
export function resolvePostedUploads(message: WebhookMessage, echo: unknown): WebhookMessage {
  const echoComponents = asArray(asObj(echo)?.components);
  let changed = false;
  const components = message.components.map((node, i) => {
    const resolved = resolveNode(node, echoComponents[i]);
    if (resolved !== node) changed = true;
    return resolved as WebhookMessage["components"][number];
  });
  return changed ? { ...message, components } : message;
}
