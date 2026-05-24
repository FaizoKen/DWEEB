/**
 * Wire ↔ editor message normalization.
 *
 * Two transformations live here:
 *
 *  - `stripEditorFields(msg)`  — turns the in-memory editor tree into a clean
 *    Discord-API-shaped payload. Drops every `_id` and any undefined optional
 *    so the JSON we copy out matches Discord's body schema exactly.
 *
 *  - `attachEditorFields(msg)` — takes an external payload (from a share URL
 *    or JSON import) and assigns fresh ids so it can be edited. Unknown
 *    fields are dropped silently; the validator surfaces structural problems.
 */

import { newId } from "@/lib/id";
import {
  ComponentType,
  type AnyComponent,
  type ContainerChild,
  type TopLevelComponent,
  type WebhookMessage,
} from "@/core/schema/types";
import { isContainer } from "@/core/schema/guards";

/** Drop the editor-only `_id` (recursively) from a message. */
export function stripEditorFields(msg: WebhookMessage): unknown {
  return {
    ...(msg.username ? { username: msg.username } : {}),
    ...(msg.avatar_url ? { avatar_url: msg.avatar_url } : {}),
    ...(msg.tts ? { tts: msg.tts } : {}),
    components: msg.components.map(stripNode),
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
  // Strip undefineds so JSON stays compact.
  for (const k of Object.keys(out)) {
    if (out[k] === undefined) delete out[k];
  }
  return out;
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
  return {
    username: typeof obj.username === "string" ? obj.username : undefined,
    avatar_url: typeof obj.avatar_url === "string" ? obj.avatar_url : undefined,
    tts: typeof obj.tts === "boolean" ? obj.tts : undefined,
    components: (obj.components as unknown[]).map(attachNode) as TopLevelComponent[],
  };
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
