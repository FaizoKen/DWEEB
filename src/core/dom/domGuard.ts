/**
 * Survive a DOM that something else rewrote underneath us.
 *
 * Preact places a new node by calling `parentDom.insertBefore(newNode, oldDom)`,
 * where `oldDom` is the sibling it remembers from the previous render. That
 * throws `NotFoundError` the moment `oldDom` is no longer a child of
 * `parentDom` — and Preact only guards the case where `oldDom` was *detached*
 * (`!oldDom.parentNode`, `diff/children.js`'s `insert`), not the case where it
 * was **re-parented**, which is precisely what an in-page translator does.
 *
 * Chrome's built-in translation (and the Google Translate widget) rewrites every
 * text node into `<font><font>…</font></font>` and **moves the original text
 * node inside the wrapper**. Preact's pointer still addresses that text node, so
 * the next render that inserts an element next to it — a conditional leading
 * icon beside a bare text child, an emoji span appearing mid-paragraph — hands
 * `insertBefore` a reference node whose parent is now the `<font>`. The whole
 * app falls to the `ErrorBoundary` over what is, at worst, a mis-ordered node on
 * a page the user asked to have rewritten. That is the 2026-07-29 production
 * `boundary` beacon ("Failed to execute 'insertBefore' on 'Node': The node
 * before which the new node is to be inserted is not a child of this node.",
 * whose top frames are Preact's `insert` ← `diffChildren`); it reproduces
 * exactly by wrapping a rendered text node the way the translator does.
 *
 * There is no seam in Preact to fix this from the outside — `options` has no
 * hook around DOM insertion — so the repair goes on the two `Node` methods that
 * throw when a remembered node has moved. **Both only change behaviour where the
 * native call would otherwise throw**, so nothing that works today is affected:
 *
 *  - `insertBefore(node, ref)` with a re-parented `ref` walks up from `ref` to
 *    the ancestor that *is* our child and inserts before that. In the translator
 *    case that ancestor is the `<font>` standing exactly where the text used to
 *    be, so the visual order Preact intended is preserved rather than merely
 *    salvaged (a plain append puts the icon after its label).
 *  - `removeChild(child)` with a foreign `child` is a no-op returning `child`.
 *    Deliberately *not* "remove it from wherever it really lives": a node that
 *    isn't ours to remove stays put, and the translator owns the wrapper it is
 *    sitting in.
 *
 * A caller that passes something which isn't a node at all still gets the native
 * `TypeError` — a genuine bug in our own code must stay loud.
 *
 * The guard reports itself once per page through the callback (see
 * `reportDomDesync`), because "we repaired something" is exactly the signal that
 * says whether the next such report is a translator or a real bug of ours.
 */

/** Minimal structural view of the `insertBefore` arguments this module reasons
 *  about — enough to unit-test the placement rule without a DOM. */
interface NodeLike {
  readonly nodeType?: number;
  readonly parentNode: NodeLike | null;
  readonly nodeName?: string;
}

/** What the guard repaired, for the one-per-page report. */
export interface DomDesync {
  /** Which method was called with a stale reference. */
  api: "insertBefore" | "removeChild";
  /** Tag name of the element the reference node actually sits under, or
   *  `"none"` when it sits under nothing. `FONT` is the translator's
   *  fingerprint — the single most diagnostic bit available here. */
  actualParent: string;
}

/**
 * Whether `ref` is a node that has drifted out from under `parent`, i.e. the
 * exact condition on which `insertBefore`/`removeChild` throw `NotFoundError`.
 *
 * `null`/`undefined` are legitimate (`insertBefore(node, null)` appends), and a
 * value that isn't node-shaped is a caller bug we must not paper over — both
 * fall through to the native method.
 */
export function isStaleReference(parent: NodeLike, ref: unknown): ref is NodeLike {
  if (ref == null || typeof ref != "object") return false;
  const node = ref as NodeLike;
  if (node.nodeType === undefined) return false;
  return node.parentNode !== parent;
}

/**
 * Where to insert instead, given a reference node that is no longer `parent`'s
 * child: the nearest ancestor of `ref` that *is* a child of `parent`, else
 * `null` (append).
 *
 * Ascending strictly terminates — a DOM tree has no cycles — and returning the
 * ancestor rather than `null` is what keeps the intended order: the translator's
 * `<font>` wrapper occupies the position its text node used to.
 */
export function resolveInsertAnchor(parent: NodeLike, ref: NodeLike): NodeLike | null {
  let anchor = ref.parentNode;
  while (anchor != null && anchor.parentNode !== parent) {
    anchor = anchor.parentNode;
  }
  return anchor;
}

/** Tag name of the reference node's real parent, for the report. */
function actualParentName(ref: NodeLike): string {
  const parent = ref.parentNode;
  return parent && typeof parent.nodeName == "string" ? parent.nodeName : "none";
}

let installed = false;

/**
 * Patch `Node.prototype.insertBefore` / `removeChild` to repair a stale
 * reference instead of throwing. Idempotent, and a no-op without a DOM.
 *
 * Install before the first render — the whole point is to be in place when a
 * translator rewrites the page mid-session. `onDesync` is invoked at most once
 * per page, on the first repair, so a translated page can't turn a hot render
 * path into a beacon loop.
 */
export function installDomDesyncGuard(onDesync: (desync: DomDesync) => void): void {
  if (installed || typeof Node == "undefined") return;
  installed = true;

  let reported = false;
  const notifyOnce = (desync: DomDesync): void => {
    if (reported) return;
    reported = true;
    try {
      onDesync(desync);
    } catch {
      // A diagnostic must never break the render that triggered it.
    }
  };

  const proto = Node.prototype;
  const nativeInsertBefore = proto.insertBefore;
  const nativeRemoveChild = proto.removeChild;

  proto.insertBefore = function <T extends Node>(this: Node, node: T, ref: Node | null): T {
    if (isStaleReference(this, ref)) {
      notifyOnce({ api: "insertBefore", actualParent: actualParentName(ref) });
      const anchor = resolveInsertAnchor(this, ref) as Node | null;
      return nativeInsertBefore.call(this, node, anchor) as T;
    }
    return nativeInsertBefore.call(this, node, ref) as T;
  };

  proto.removeChild = function <T extends Node>(this: Node, child: T): T {
    if (isStaleReference(this, child)) {
      notifyOnce({ api: "removeChild", actualParent: actualParentName(child) });
      return child;
    }
    return nativeRemoveChild.call(this, child) as T;
  };
}
