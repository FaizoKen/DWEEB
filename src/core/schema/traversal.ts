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

import { isActionRow, isContainer, isMediaGallery, isSection, isStringSelect } from "./guards";
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
    for (const child of node.components) yield child;
  } else if (isMediaGallery(node)) {
    // gallery items are not standalone components — skip
  }
}

/**
 * True when `id` is this node or any descendant. Unlike `walk`, this also
 * matches media-gallery item ids: items aren't standalone components, but the
 * editor selects them individually, and callers (e.g. spoiler reveal) need a
 * selected gallery item to count as "inside" its container.
 */
export function subtreeContainsId(node: AnyComponent, id: EditorId): boolean {
  if (node._id === id) return true;
  if (isContainer(node)) return node.components.some((c) => subtreeContainsId(c, id));
  if (isSection(node))
    return (
      node.components.some((c) => subtreeContainsId(c, id)) || subtreeContainsId(node.accessory, id)
    );
  if (isActionRow(node)) return node.components.some((c) => subtreeContainsId(c, id));
  if (isMediaGallery(node)) return node.items.some((item) => item._id === id);
  return false;
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
 *
 * Counts: TextDisplay.content, Button.label, Thumbnail/MediaGallery.description,
 * Select.placeholder, StringSelect option label/description, plus the
 * webhook username override.
 */
export function countCharacters(message: WebhookMessage): number {
  let n = 0;
  for (const c of walk(message)) {
    if ("content" in c && typeof c.content === "string") n += c.content.length;
    if ("label" in c && typeof c.label === "string") n += c.label.length;
    if ("description" in c && typeof c.description === "string") n += c.description.length;
    if ("placeholder" in c && typeof c.placeholder === "string") n += c.placeholder.length;
    if (isStringSelect(c)) {
      for (const opt of c.options) {
        n += opt.label.length;
        if (opt.description) n += opt.description.length;
      }
    }
  }
  if (message.username) n += message.username.length;
  return n;
}

/**
 * Concatenate every human-readable text field in a message into one lowercased
 * haystack for searching — the same fields {@link countCharacters} totals
 * (TextDisplay content, button/option labels, descriptions, select
 * placeholders, username), plus the thread name and media alt text. Lets the
 * gallery search find a saved/posted message by the words it actually contains,
 * not just its label.
 */
export function collectSearchText(message: WebhookMessage): string {
  const parts: string[] = [];
  const add = (v: unknown): void => {
    if (typeof v === "string" && v.length > 0) parts.push(v);
  };
  add(message.username);
  add(message.thread_name);
  for (const c of walk(message)) {
    if ("content" in c) add((c as { content?: unknown }).content);
    if ("label" in c) add((c as { label?: unknown }).label);
    if ("description" in c) add((c as { description?: unknown }).description);
    if ("placeholder" in c) add((c as { placeholder?: unknown }).placeholder);
    if (isStringSelect(c)) {
      for (const opt of c.options) {
        add(opt.label);
        add(opt.description);
      }
    }
    if (isMediaGallery(c)) {
      for (const item of c.items) add(item.description);
    }
  }
  return parts.join(" ").toLowerCase();
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
    if (node.accessory._id === id) return { node: node.accessory, parent: node, index: 0 };
  } else if (isActionRow(node)) {
    for (let i = 0; i < node.components.length; i++) {
      const child = node.components[i]!;
      if (child._id === id) return { node: child, parent: node, index: i };
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
    return changed
      ? ({ ...node, components: components as typeof node.components } as AnyComponent)
      : node;
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
      components: node.components.filter((c) => c._id !== id) as typeof node.components,
    };
  }
  return node;
}
