/**
 * The read-only fields Discord stamps onto every media item of a message it
 * returns (a restored message, an echo). All output-only: the execute and edit
 * endpoints refuse a message that sends any of them back. The send path
 * (`attachments.ts`), the code export (`codegen/payload.ts`), the JSON export
 * and the proxy/dispatcher echo paths all drop them — keep the lists in step.
 */

import { ComponentType } from "@/core/schema/types";

export const RESOLVED_MEDIA_FIELDS = [
  "proxy_url",
  "height",
  "width",
  "content_type",
  "loading_state",
  "id",
  "placeholder",
  "placeholder_version",
  "content_scan_metadata",
  "flags",
] as const;

function stripMedia(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const k of RESOLVED_MEDIA_FIELDS) delete out[k];
  // A restored item carries both the CDN `url` and the original upload's
  // `attachment_id`, and Discord refuses the pair: the url is the reference
  // that survives a re-post.
  if (typeof out.url === "string" && out.url.length > 0) delete out.attachment_id;
  return out;
}

function stripNode(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const node: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  if (node.type === ComponentType.File) node.file = stripMedia(node.file);
  if (node.type === ComponentType.Thumbnail) node.media = stripMedia(node.media);
  if (node.type === ComponentType.MediaGallery && Array.isArray(node.items)) {
    node.items = node.items.map((item: unknown) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? {
            ...(item as Record<string, unknown>),
            media: stripMedia((item as { media?: unknown }).media),
          }
        : item,
    );
  }
  if (Array.isArray(node.components)) node.components = node.components.map(stripNode);
  if (node.accessory) node.accessory = stripNode(node.accessory);
  return node;
}

/**
 * A copy of a wire payload with Discord's read-only media fields removed — so
 * an exported restored message can be POSTed as-is, as the JSON tab promises.
 * Leaves everything else, including an empty `url`, exactly as it was.
 */
export function withoutResolvedMedia<T>(payload: T): T {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const obj = { ...(payload as Record<string, unknown>) };
  if (Array.isArray(obj.components)) obj.components = obj.components.map(stripNode);
  return obj as T;
}
