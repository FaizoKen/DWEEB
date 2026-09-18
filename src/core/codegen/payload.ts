/**
 * The wire payload the code generators read, and the one transformation code
 * export needs that JSON export does not.
 *
 * JSON export blanks an in-session upload (`session://<blob>/<name>` → `""`):
 * the recipient of a JSON file has no way to supply the bytes. Generated code is
 * different — it runs on the developer's own machine, where they *can* put the
 * file next to the script. So here a session upload becomes the
 * `attachment://<name>` reference Discord expects, and its filename is
 * collected so every target can emit the matching upload (an
 * `AttachmentBuilder`, a `discord.File`, a multipart part). An `attachment://`
 * URL that was typed by hand or restored from Discord is collected the same
 * way, since it needs exactly the same upload to resolve.
 */

import { stripEditorFields } from "@/core/serialization/normalize";
import { parseSessionUrl } from "@/core/state/attachmentStore";
import type { WebhookMessage } from "@/core/schema/types";

/** A component as it appears on the wire — plain JSON, no editor ids. */
export type WireNode = Record<string, unknown>;

export interface WirePayload {
  username?: string;
  avatar_url?: string;
  tts?: boolean;
  allowed_mentions?: {
    parse?: string[];
    roles?: string[];
    users?: string[];
    replied_user?: boolean;
  };
  thread_name?: string;
  applied_tags?: string[];
  components: WireNode[];
  flags: number;
}

export interface CodegenInput {
  payload: WirePayload;
  /** Distinct `attachment://` filenames the payload references, in first-use order. */
  attachments: string[];
}

const ATTACHMENT_PREFIX = "attachment://";

/**
 * Fields Discord stamps onto a media item when it returns a message. They are
 * output-only — the API rejects them on the way back in — so a restored message
 * must not carry them into code that is meant to be pasted and run.
 */
const RESOLVED_MEDIA_FIELDS = [
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
  "attachment_id",
] as const;

export function prepareCodegenInput(message: WebhookMessage): CodegenInput {
  const payload = stripEditorFields(message) as WirePayload;
  const attachments: string[] = [];
  const bySession = new Map<string, string>();

  const claim = (desired: string): string => {
    if (!attachments.includes(desired)) return desired;
    const dot = desired.lastIndexOf(".");
    const base = dot > 0 ? desired.slice(0, dot) : desired;
    const ext = dot > 0 ? desired.slice(dot) : "";
    let i = 2;
    while (attachments.includes(`${base}_${i}${ext}`)) i++;
    return `${base}_${i}${ext}`;
  };

  const resolveUrl = (url: string): string => {
    const session = parseSessionUrl(url);
    if (session) {
      const known = bySession.get(session.blobId);
      if (known) return `${ATTACHMENT_PREFIX}${known}`;
      const name = claim(session.filename || "file");
      bySession.set(session.blobId, name);
      attachments.push(name);
      return `${ATTACHMENT_PREFIX}${name}`;
    }
    if (url.startsWith(ATTACHMENT_PREFIX)) {
      const name = url.slice(ATTACHMENT_PREFIX.length);
      if (name && !attachments.includes(name)) attachments.push(name);
    }
    return url;
  };

  const cleanMedia = (raw: unknown): unknown => {
    if (!raw || typeof raw !== "object") return raw;
    const media: WireNode = { ...(raw as WireNode) };
    for (const field of RESOLVED_MEDIA_FIELDS) delete media[field];
    if (typeof media.url === "string") media.url = resolveUrl(media.url);
    return media;
  };

  const walk = (node: WireNode): void => {
    if ("media" in node) node.media = cleanMedia(node.media);
    if ("file" in node) node.file = cleanMedia(node.file);
    if (Array.isArray(node.items)) {
      node.items = node.items.map((item: unknown) =>
        item && typeof item === "object"
          ? { ...(item as WireNode), media: cleanMedia((item as WireNode).media) }
          : item,
      );
    }
    if (Array.isArray(node.components)) {
      for (const child of node.components) {
        if (child && typeof child === "object") walk(child as WireNode);
      }
    }
    if (node.accessory && typeof node.accessory === "object") walk(node.accessory as WireNode);
  };

  for (const top of payload.components) walk(top);
  return { payload, attachments };
}

/** True when any component needs an application to receive its interaction. */
export function hasInteractiveComponents(nodes: readonly WireNode[]): boolean {
  return nodes.some((node) => {
    if (typeof node.custom_id === "string") return true;
    const children = Array.isArray(node.components) ? (node.components as WireNode[]) : [];
    const accessory =
      node.accessory && typeof node.accessory === "object" ? [node.accessory as WireNode] : [];
    return hasInteractiveComponents([...children, ...accessory]);
  });
}
