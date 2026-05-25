/**
 * Resolve session-only blob URLs into Discord's multipart attachment shape.
 *
 * The editor stores in-memory file uploads as opaque `session://<id>/<name>`
 * URLs on every media-bearing field (File, Thumbnail, MediaGalleryItem). This
 * pass walks the wire payload, replaces every such reference with the
 * `attachment://<filename>` form Discord expects, and produces a parallel
 * list of `File` blobs (deduplicated per blob id) to upload alongside the
 * JSON payload.
 *
 * The function operates on the stripped wire payload, not the editor tree,
 * so the encoding for share URLs / JSON export stays free of any multipart
 * concerns — only the live send/update path uses this.
 *
 * Restored messages from Discord arrive with resolved fields on every media
 * item (`proxy_url`, `height`, `width`, `content_type`, `loading_state`).
 * These are server-side metadata that the execute endpoint does not accept
 * back; we drop them here so a "restore → edit → update" round-trip stays
 * accepted.
 */

import {
  ComponentType,
  type WebhookMessage,
} from "@/core/schema/types";
import { stripEditorFields } from "./normalize";
import {
  getAttachmentFile,
  parseSessionUrl,
} from "@/core/state/attachmentStore";

export interface CollectedFile {
  file: File;
  filename: string;
}

export interface CollectedAttachments {
  /** The wire payload with every `session://` URL rewritten. */
  payload: Record<string, unknown>;
  /** Files to upload in multipart parts (positional). Deduped by blob id. */
  files: CollectedFile[];
}

const RESOLVED_MEDIA_FIELDS = [
  "proxy_url",
  "height",
  "width",
  "content_type",
  "loading_state",
] as const;

/** Drop server-only resolved fields and reconcile `url` vs `attachment_id`. */
function cleanMedia(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  for (const k of RESOLVED_MEDIA_FIELDS) delete out[k];
  // Prefer `attachment_id` when both are set; Discord rejects payloads carrying
  // an attachment_id alongside an unrelated url.
  if (typeof out.attachment_id === "string" && out.attachment_id.length > 0) {
    delete out.url;
  } else if (typeof out.url !== "string" || out.url.length === 0) {
    delete out.url;
  }
  return out;
}

/**
 * Strip editor ids, then walk the result and rewrite any in-memory blob URLs
 * to `attachment://<filename>` while collecting the underlying File objects.
 *
 * Filenames are made unique across files (Discord ignores duplicates and we
 * don't want one rename clobbering another). The first occurrence of a blob
 * keeps its filename; subsequent collisions get a `(2)`, `(3)`, ... suffix.
 */
export function collectSessionAttachments(message: WebhookMessage): CollectedAttachments {
  const payload = stripEditorFields(message) as Record<string, unknown>;
  const files: CollectedFile[] = [];
  const seenBlob = new Map<string, string>(); // blobId → final filename
  const usedNames = new Set<string>();

  const claimFilename = (desired: string): string => {
    if (!usedNames.has(desired)) {
      usedNames.add(desired);
      return desired;
    }
    const dot = desired.lastIndexOf(".");
    const base = dot > 0 ? desired.slice(0, dot) : desired;
    const ext = dot > 0 ? desired.slice(dot) : "";
    let i = 2;
    while (usedNames.has(`${base}(${i})${ext}`)) i++;
    const next = `${base}(${i})${ext}`;
    usedNames.add(next);
    return next;
  };

  const rewriteUrl = (url: string): string => {
    const parsed = parseSessionUrl(url);
    if (!parsed) return url;
    const existing = seenBlob.get(parsed.blobId);
    if (existing) return `attachment://${existing}`;
    const file = getAttachmentFile(parsed.blobId);
    if (!file) {
      // Blob has been GC'd — surface a sentinel so Discord rejects the send
      // with a clear error rather than silently shipping a broken reference.
      return "attachment://missing-attachment";
    }
    const finalName = claimFilename(parsed.filename || file.name || "file");
    seenBlob.set(parsed.blobId, finalName);
    files.push({ file, filename: finalName });
    return `attachment://${finalName}`;
  };

  const handleMedia = (media: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
    if (!media) return undefined;
    const next = { ...media };
    if (typeof next.url === "string") next.url = rewriteUrl(next.url);
    return cleanMedia(next);
  };

  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;

    const type = typeof obj.type === "number" ? obj.type : null;

    if (type === ComponentType.File) {
      obj.file = handleMedia(obj.file as Record<string, unknown> | undefined);
    } else if (type === ComponentType.Thumbnail) {
      obj.media = handleMedia(obj.media as Record<string, unknown> | undefined);
    } else if (type === ComponentType.MediaGallery) {
      const items = obj.items;
      if (Array.isArray(items)) {
        obj.items = items.map((raw) => {
          if (!raw || typeof raw !== "object") return raw;
          const item = { ...(raw as Record<string, unknown>) };
          item.media = handleMedia(item.media as Record<string, unknown> | undefined);
          return item;
        });
      }
    }

    // Recurse into children / accessory / nested arrays.
    if (Array.isArray(obj.components)) {
      for (const child of obj.components) walk(child);
    }
    if (obj.accessory) walk(obj.accessory);
  };

  if (Array.isArray(payload.components)) {
    for (const top of payload.components) walk(top);
  }

  return { payload, files };
}
