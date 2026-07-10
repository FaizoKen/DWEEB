/**
 * Wire ↔ editor message normalization.
 *
 * Two transformations live here:
 *
 *  - `stripEditorFields(msg)`  — turns the in-memory editor tree into a clean
 *    Discord-API-shaped payload. Drops every `_id` and any undefined optional
 *    so the JSON we copy out matches Discord's body schema exactly, and emits
 *    the computed `flags` integer so the payload is postable as-is (Discord
 *    rejects V2 components when `IS_COMPONENTS_V2` is absent).
 *
 *  - `attachEditorFields(msg)` — takes an external payload (from a share URL
 *    or JSON import) and assigns fresh ids so it can be edited. Unknown
 *    fields are dropped silently; the validator surfaces structural problems.
 *    `flags` is the one wire-only field we read back — its silent-send bit is
 *    lifted into `suppress_notifications` so the toggle round-trips.
 */

import { newId } from "@/lib/id";
import {
  ComponentType,
  computeMessageFlags,
  flagsHaveSuppressNotifications,
  type AllowedMentions,
  type AnyComponent,
  type ContainerChild,
  type MessageReference,
  type TopLevelComponent,
  type WebhookMessage,
} from "@/core/schema/types";
import { isContainer } from "@/core/schema/guards";
import { isSessionUrl } from "@/core/state/attachmentStore";

/**
 * Drop the editor-only `_id` (recursively) from a message.
 *
 * Note: `message_reference` is intentionally **not** emitted — Discord's
 * webhook execute endpoint does not accept it. We keep the field on
 * `WebhookMessage` so restored payloads round-trip, but stripping it here
 * prevents accidentally shipping a payload Discord would 400 on.
 */
export function stripEditorFields(msg: WebhookMessage): unknown {
  return {
    ...(msg.username ? { username: msg.username } : {}),
    ...(msg.avatar_url ? { avatar_url: msg.avatar_url } : {}),
    ...(msg.tts ? { tts: msg.tts } : {}),
    ...(msg.allowed_mentions ? { allowed_mentions: stripUndefined(msg.allowed_mentions) } : {}),
    ...(msg.thread_name ? { thread_name: msg.thread_name } : {}),
    ...(msg.applied_tags && msg.applied_tags.length > 0
      ? { applied_tags: msg.applied_tags.slice() }
      : {}),
    components: msg.components.map(stripNode),
    flags: computeMessageFlags(msg),
  };
}

function stripNode(node: AnyComponent): unknown {
  const { _id: _drop, ...rest } = node as AnyComponent & { _id: string };
  const out: Record<string, unknown> = { ...rest };
  // Recurse into structural children.
  if ("components" in node && Array.isArray((node as { components?: unknown }).components)) {
    out.components = (node as unknown as { components: AnyComponent[] }).components.map(stripNode);
  }
  if ("accessory" in node && (node as { accessory?: AnyComponent }).accessory) {
    out.accessory = stripNode((node as { accessory: AnyComponent }).accessory);
  }
  // Gallery items carry an editor-only `_id` like components do — drop it so
  // the exported items match Discord's media-gallery item schema.
  if (Array.isArray((node as { items?: unknown }).items)) {
    out.items = (node as unknown as { items: Array<Record<string, unknown>> }).items.map((item) => {
      const { _id: _dropItem, ...itemRest } = item as { _id?: string };
      const itemOut: Record<string, unknown> = { ...itemRest };
      for (const k of Object.keys(itemOut)) {
        if (itemOut[k] === undefined) delete itemOut[k];
      }
      return itemOut;
    });
  }
  // Strip undefineds so JSON stays compact.
  for (const k of Object.keys(out)) {
    if (out[k] === undefined) delete out[k];
  }
  return out;
}

function stripUndefined<T extends object>(obj: T): T {
  const out: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
  for (const k of Object.keys(out)) {
    if (out[k] === undefined) delete out[k];
  }
  return out as T;
}

/** Re-attach editor fields to a parsed external payload. */
export function attachEditorFields(input: unknown): WebhookMessage {
  if (!input || typeof input !== "object") {
    throw new Error("Imported payload must be an object.");
  }
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.components)) {
    throw new Error("Imported payload must have a `components` array.");
  }

  const allowed_mentions = parseAllowedMentions(obj.allowed_mentions);
  const message_reference = parseMessageReference(obj.message_reference);
  const applied_tags = Array.isArray(obj.applied_tags)
    ? (obj.applied_tags.filter((t) => typeof t === "string") as string[])
    : undefined;

  return {
    username: typeof obj.username === "string" ? obj.username : undefined,
    avatar_url: typeof obj.avatar_url === "string" ? obj.avatar_url : undefined,
    tts: typeof obj.tts === "boolean" ? obj.tts : undefined,
    suppress_notifications: flagsHaveSuppressNotifications(obj.flags) ? true : undefined,
    allowed_mentions,
    message_reference,
    thread_name: typeof obj.thread_name === "string" ? obj.thread_name : undefined,
    applied_tags: applied_tags && applied_tags.length > 0 ? applied_tags : undefined,
    components: (obj.components as unknown[]).map(attachNode) as TopLevelComponent[],
  };
}

function parseAllowedMentions(raw: unknown): AllowedMentions | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const out: AllowedMentions = {};
  if (Array.isArray(o.parse)) {
    const parse = o.parse.filter(
      (v): v is "roles" | "users" | "everyone" =>
        v === "roles" || v === "users" || v === "everyone",
    );
    if (parse.length > 0) out.parse = parse;
  }
  if (Array.isArray(o.roles)) {
    const roles = o.roles.filter((v): v is string => typeof v === "string");
    if (roles.length > 0) out.roles = roles;
  }
  if (Array.isArray(o.users)) {
    const users = o.users.filter((v): v is string => typeof v === "string");
    if (users.length > 0) out.users = users;
  }
  if (typeof o.replied_user === "boolean") out.replied_user = o.replied_user;
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseMessageReference(raw: unknown): MessageReference | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.message_id !== "string" || o.message_id.length === 0) return undefined;
  const out: MessageReference = { message_id: o.message_id };
  if (typeof o.channel_id === "string") out.channel_id = o.channel_id;
  if (typeof o.guild_id === "string") out.guild_id = o.guild_id;
  if (typeof o.type === "number") out.type = o.type;
  if (typeof o.fail_if_not_exists === "boolean") out.fail_if_not_exists = o.fail_if_not_exists;
  return out;
}

function attachNode(raw: unknown): AnyComponent {
  if (!raw || typeof raw !== "object") {
    throw new Error("Component must be an object.");
  }
  const node = raw as Record<string, unknown>;
  if (typeof node.type !== "number") {
    throw new Error("Component is missing a numeric `type` field.");
  }
  const stamped: Record<string, unknown> = { ...node, _id: newId() };

  if (Array.isArray(stamped.components)) {
    stamped.components = (stamped.components as unknown[]).map(attachNode);
  }
  if (stamped.accessory) {
    stamped.accessory = attachNode(stamped.accessory);
  }
  // Stamp a fresh editor id onto each gallery item so they're selectable and
  // reorderable as tree rows. Mirrors the per-component stamping above.
  if (Array.isArray(stamped.items)) {
    stamped.items = (stamped.items as unknown[]).map((item) =>
      item && typeof item === "object"
        ? { ...(item as Record<string, unknown>), _id: newId() }
        : item,
    );
  }
  // Container children get constrained; the validator catches type mismatches.
  if (stamped.type === ComponentType.Container && Array.isArray(stamped.components)) {
    stamped.components = stamped.components as ContainerChild[];
  }
  return stamped as unknown as AnyComponent;
}

/** Convenience: collect the total component count post-import for logging. */
export function depthOf(node: AnyComponent): number {
  if (isContainer(node)) {
    return 1 + Math.max(0, ...node.components.map((c) => depthOf(c)));
  }
  return 1;
}

/**
 * Replace any `session://` URLs with an empty string before serializing to
 * share URL / JSON export. The recipient's browser has no access to our
 * in-memory blob registry, so leaving the ref intact would just produce a
 * dangling reference. Empty surfaces in the validator as "needs a URL".
 *
 * This mutates a defensive deep copy; the editor state stays untouched.
 */
export function stripSessionAttachments(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  if (Array.isArray(payload)) return payload.map((p) => stripSessionAttachments(p));
  const obj = { ...(payload as Record<string, unknown>) };
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (key === "url" && typeof value === "string" && isSessionUrl(value)) {
      obj[key] = "";
    } else if (value && typeof value === "object") {
      obj[key] = stripSessionAttachments(value);
    }
  }
  return obj;
}

/**
 * Whether a message-shaped value contains an in-session upload URL.
 *
 * These URLs point at bytes held by this browser's attachment registry. They
 * are safe in the local auto-save, but a server draft would leave teammates and
 * other devices with a dangling reference. Only media `url` fields count: text
 * content is allowed to mention the `session://` scheme without being mistaken
 * for an upload.
 */
export function hasSessionAttachments(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  if (Array.isArray(payload)) return payload.some(hasSessionAttachments);
  return Object.entries(payload as Record<string, unknown>).some(([key, value]) => {
    if (key === "url" && typeof value === "string" && isSessionUrl(value)) return true;
    return value != null && typeof value === "object" && hasSessionAttachments(value);
  });
}
