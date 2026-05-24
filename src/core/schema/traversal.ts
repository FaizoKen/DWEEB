/**
 * Tree traversal helpers for the editor state.
 *
 * The component tree is a small recursive structure (containers → children →
 * sections → texts / accessories). Rather than scattering recursion logic
 * through reducers and renderers, every traversal goes through one of the
 * functions here.
 *
 * Invariants:
 *  - Every node has a unique `_id`. Lookups by id are O(n).
 *  - `findById` returns both the node and its parent slot so callers can
 *    immutably replace, remove, or splice the node without re-walking the tree.
 */

import {
  isActionRow,
  isContainer,
  isMediaGallery,
  isSection,
} from "./guards";
import type {
  AnyComponent,
  ContainerChild,
  EditorId,
  TopLevelComponent,
  WebhookMessage,
} from "./types";

/** Yields every component in document order, including nested ones. */
export function* walk(message: WebhookMessage): Generator<AnyComponent> {
  for (const c of message.components) yield* walkNode(c);
}

function* walkNode(node: AnyComponent): Generator<AnyComponent> {
  yield node;
  if (isContainer(node)) {
    for (const child of node.components) yield* walkNode(child);
  } else if (isSection(node)) {
    for (const text of node.components) yield text;
    yield node.accessory;
  } else if (isActionRow(node)) {
    for (const btn of node.components) yield btn;
  } else if (isMediaGallery(node)) {
    // gallery items are not standalone components — skip
  }
}

/** O(n) total-component count. */
export function countComponents(message: WebhookMessage): number {
  let n = 0;
  for (const _ of walk(message)) n++;
  return n;
}

/**
 * Sum of every text-bearing field across the message. Used to enforce the
 * 4000-character message-wide cap that Discord applies on top of Components V2.
 */
export function countCharacters(message: WebhookMessage): number {
  let n = 0;
  for (const c of walk(message)) {
    if ("content" in c && typeof c.content === "string") n += c.content.length;
    if ("label" in c && typeof c.label === "string") n += c.label.length;
    if ("description" in c && typeof c.description === "string") n += c.description.length;
  }
  if (message.username) n += message.username.length;
  return n;
}

/**
 * Find a node by id, returning the node plus enough context for an immutable
 * structural edit. Returns `null` when not found.
 */
export interface NodeLocation {
  node: AnyComponent;
  /** Parent node, or null when the node sits at the message root. */
  parent: AnyComponent | null;
  /** Index inside the parent's child array, when applicable. */
  index: number;
}

export function findById(message: WebhookMessage, id: EditorId): NodeLocation | null {
  for (let i = 0; i < message.components.length; i++) {
    const top = message.components[i]!;
    if (top._id === id) return { node: top, parent: null, index: i };
    const inside = findInside(top, id);
    if (inside) return inside;
  }
  return null;
}

function findInside(node: AnyComponent, id: EditorId): NodeLocation | null {
  if (isContainer(node)) {
    for (let i = 0; i < node.components.length; i++) {
      const child = node.components[i]!;
      if (child._id === id) return { node: child, parent: node, index: i };
      const deeper = findInside(child, id);
      if (deeper) return deeper;
    }
  } else if (isSection(node)) {
    for (let i = 0; i < node.components.length; i++) {
      const text = node.components[i]!;
      if (text._id === id) return { node: text, parent: node, index: i };
    }
    if (node.accessory._id === id)
      return { node: node.accessory, parent: node, index: 0 };
  } else if (isActionRow(node)) {
    for (let i = 0; i < node.components.length; i++) {
      const btn = node.components[i]!;
      if (btn._id === id) return { node: btn, parent: node, index: i };
    }
  }
  return null;
}

/**
 * Replace a node by id with the result of a mapping function. Returns a new
 * message tree — does not mutate the input. If the id is not found the
 * original message is returned unchanged.
 */
export function updateById<T extends AnyComponent>(
  message: WebhookMessage,
  id: EditorId,
  update: (node: T) => T,
): WebhookMessage {
  let changed = false;
  const next = message.components.map((top) => {
    const result = mapNode(top, id, update);
    if (result !== top) changed = true;
    return result;
  });
  if (!changed) return message;
  return { ...message, components: next as TopLevelComponent[] };
}

function mapNode<T extends AnyComponent>(
  node: AnyComponent,
  id: EditorId,
  update: (n: T) => T,
): AnyComponent {
  if (node._id === id) return update(node as T);

  if (isContainer(node)) {
    let changed = false;
    const components = node.components.map((c) => {
      const next = mapNode(c, id, update) as ContainerChild;
      if (next !== c) changed = true;
      return next;
    });
    return changed ? { ...node, components } : node;
  }

  if (isSection(node)) {
    let changed = false;
    const components = node.components.map((c) => {
      const next = mapNode(c, id, update);
      if (next !== c) changed = true;
      return next as typeof c;
    });
    const accessory = mapNode(node.accessory, id, update) as typeof node.accessory;
    if (accessory !== node.accessory) changed = true;
    return changed ? { ...node, components, accessory } : node;
  }

  if (isActionRow(node)) {
    let changed = false;
    const components = node.components.map((c) => {
      const next = mapNode(c, id, update) as typeof c;
      if (next !== c) changed = true;
      return next;
    });
    return changed ? { ...node, components } : node;
  }

  return node;
}

/**
 * Remove a node by id. Returns a new message tree. If the removal would
 * violate a structural minimum (e.g. a Section needs ≥1 TextDisplay), the
 * removal is performed anyway — the caller is expected to consult
 * `validation.ts` before accepting the result.
 */
export function removeById(message: WebhookMessage, id: EditorId): WebhookMessage {
  return {
    ...message,
    components: message.components
      .filter((c) => c._id !== id)
      .map((c) => removeInside(c, id) as TopLevelComponent),
  };
}

function removeInside(node: AnyComponent, id: EditorId): AnyComponent {
  if (isContainer(node)) {
    return {
      ...node,
      components: node.components
        .filter((c) => c._id !== id)
        .map((c) => removeInside(c, id) as ContainerChild),
    };
  }
  if (isSection(node)) {
    return {
      ...node,
      components: node.components.filter((c) => c._id !== id),
    };
  }
  if (isActionRow(node)) {
    return {
      ...node,
      components: node.components.filter((c) => c._id !== id),
    };
  }
  return node;
}
