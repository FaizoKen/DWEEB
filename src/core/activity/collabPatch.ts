/**
 * Collaboration patch protocol — granular, last-write-wins **per node**.
 *
 * The first cut broadcast the whole message on every edit and replaced it
 * wholesale on receipt, so two people editing different parts clobbered each
 * other: the slower debounce's snapshot reverted the other's change (a visible
 * "revert war"). This computes the *minimal* set of changes between two message
 * snapshots and applies them node-by-node, so concurrent edits to **different**
 * nodes — or to a node vs. the message-level options — never collide. Concurrent
 * edits to the **same** node still resolve last-write-wins: the honest, bounded
 * tradeoff for a small group co-writing one message.
 *
 * Two properties make this cheap and precise:
 *  - every node carries a stable `_id`, and
 *  - the editor store rebuilds only the path to an edited node (untouched
 *    subtrees keep their object identity), so a `prev === next` reference check
 *    skips unchanged subtrees in O(changed) rather than O(tree).
 *
 * Granularity:
 *  - **leaf / media-gallery** nodes are atomic — any change emits a `node` op
 *    replacing the whole subtree (they hold no independently-editable children).
 *  - **branch** nodes (container / section / action row) are diffed by child id:
 *    a *structural* change (add / remove / reorder a child, or swap a Section's
 *    accessory) emits one `node` op for the whole subtree; otherwise we recurse
 *    into the children and, for the branch's *own* fields (e.g. a Container's
 *    accent colour), emit a `props` op that merges without disturbing
 *    concurrently-edited children.
 *  - **message-level** fields (username, avatar, mentions, …) are a single
 *    authoritative `meta` op, independent of the component tree.
 *  - a **top-level** structural change (add / remove / reorder a root component)
 *    can't be expressed as in-place ops, so `diffMessage` returns `null` and the
 *    caller falls back to broadcasting the full message.
 */

import {
  isActionRow,
  isContainer,
  isSection,
  updateById,
  type AnyComponent,
  type EditorId,
  type WebhookMessage,
} from "@/core/schema";

/** Keys that hold *child nodes* rather than a node's own data — excluded from a
 *  node's "own props" and preserved when a `props` op merges in. */
const CHILD_KEYS = ["components", "accessory", "items"] as const;

/** All message fields except the component tree (username, avatar, …). */
type MessageMeta = Omit<WebhookMessage, "components">;

/** One change in a patch frame. Several may ride in a single `patch` (one local
 *  edit can touch a node and the message meta in the same debounced burst). */
export type CollabOp =
  | { op: "meta"; data: MessageMeta }
  /** Replace node `id`'s entire subtree (leaf edit, atomic node, or a localized
   *  structural change). */
  | { op: "node"; id: EditorId; data: AnyComponent }
  /** Merge `data` into node `id`'s own fields, keeping its current children. */
  | { op: "props"; id: EditorId; data: Record<string, unknown> };

// ── Diff (prev → next) ───────────────────────────────────────────────────────

/**
 * Compute the ops that turn `prev` into `next`, or `null` when the top-level
 * component list changed shape (add / remove / reorder) — which can't be applied
 * in place, so the caller should broadcast the full message instead.
 */
export function diffMessage(prev: WebhookMessage, next: WebhookMessage): CollabOp[] | null {
  const ops: CollabOp[] = [];
  if (!jsonEqual(messageMeta(prev), messageMeta(next))) {
    ops.push({ op: "meta", data: messageMeta(next) });
  }
  // A changed root structure isn't expressible as node ops — bail to a snapshot.
  if (!idsEqual(prev.components, next.components)) return null;
  for (let i = 0; i < next.components.length; i++) {
    diffNode(prev.components[i]!, next.components[i]!, ops);
  }
  return ops;
}

function diffNode(prev: AnyComponent, next: AnyComponent, ops: CollabOp[]): void {
  if (prev === next) return; // untouched subtree (the store keeps its identity)
  const id = next._id;
  // A type change restructures the node's whole shape → replace it outright.
  if (prev.type !== next.type) {
    ops.push({ op: "node", id, data: next });
    return;
  }
  const nextKids = childCollections(next);
  // Atomic node (leaf or media gallery): no independently-editable children, so
  // any change is a whole-node replace.
  if (nextKids.length === 0) {
    ops.push({ op: "node", id, data: next });
    return;
  }
  const prevKids = childCollections(prev);
  // A structural change in any child collection (added / removed / reordered, or
  // an accessory swapped for a different node) → replace the whole subtree.
  for (let i = 0; i < nextKids.length; i++) {
    if (!idsEqual(prevKids[i]!, nextKids[i]!)) {
      ops.push({ op: "node", id, data: next });
      return;
    }
  }
  // Same structure → recurse into each child by aligned id.
  for (let i = 0; i < nextKids.length; i++) {
    const p = prevKids[i]!;
    const n = nextKids[i]!;
    for (let j = 0; j < n.length; j++) diffNode(p[j]!, n[j]!, ops);
  }
  // The branch's own fields changed without a structural change (e.g. a
  // Container's accent colour) → a props patch that won't disturb a child a peer
  // is editing concurrently.
  if (!jsonEqual(ownProps(prev), ownProps(next))) {
    ops.push({ op: "props", id, data: ownProps(next) });
  }
}

// ── Apply (ops → message) ────────────────────────────────────────────────────

/**
 * Apply `ops` to `message`, returning a new tree (the input is untouched).
 * Built on the ref-preserving `updateById`, so untouched subtrees keep their
 * identity — which both keeps React renders minimal and lets the caller advance
 * its sync baseline by re-applying the same ops. Ops targeting a node that no
 * longer exists (concurrently removed) are silently skipped.
 */
export function applyOps(message: WebhookMessage, ops: readonly CollabOp[]): WebhookMessage {
  let out = message;
  for (const op of ops) {
    if (op.op === "meta") {
      // Meta is authoritative: take all non-component fields from the op (so a
      // cleared field, absent after the JSON round-trip, is dropped) and keep
      // the current component tree.
      out = { ...op.data, components: out.components };
    } else if (op.op === "node") {
      out = updateById(out, op.id, () => op.data);
    } else {
      out = updateById(out, op.id, (node) => mergeOwnProps(node, op.data));
    }
  }
  return out;
}

/** Overlay `data` (a node's own fields) onto `node`, keeping its current child
 *  collections and id. `data` is authoritative for own fields, so a field absent
 *  from it (cleared, dropped by JSON) is cleared on the result. */
function mergeOwnProps(node: AnyComponent, data: Record<string, unknown>): AnyComponent {
  const src = node as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...data, _id: node._id };
  for (const k of CHILD_KEYS) {
    if (k in src) out[k] = src[k];
  }
  return out as unknown as AnyComponent;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A branch node's child-node collections, each as an array (the Section
 *  accessory is wrapped as a one-element array so it diffs uniformly). Empty for
 *  an atomic node — leaf components and media galleries. */
function childCollections(node: AnyComponent): AnyComponent[][] {
  if (isContainer(node)) return [node.components as AnyComponent[]];
  if (isSection(node)) return [[node.accessory as AnyComponent], node.components as AnyComponent[]];
  if (isActionRow(node)) return [node.components as AnyComponent[]];
  return [];
}

/** A node's own fields — everything except its child-node collections. */
function ownProps(node: AnyComponent): Record<string, unknown> {
  const src = node as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src)) {
    if (!(CHILD_KEYS as readonly string[]).includes(k)) out[k] = src[k];
  }
  return out;
}

/** The message's non-component fields. */
function messageMeta(message: WebhookMessage): MessageMeta {
  const src = message as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src)) {
    if (k !== "components") out[k] = src[k];
  }
  return out as unknown as MessageMeta;
}

/** Same length and same ids in the same order. */
function idsEqual(a: readonly { _id: EditorId }[], b: readonly { _id: EditorId }[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i]!._id !== b[i]!._id) return false;
  return true;
}

/** Structural equality for the small plain objects we compare (order-insensitive
 *  so two equivalent shapes never diff spuriously). */
function jsonEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "undefined";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
