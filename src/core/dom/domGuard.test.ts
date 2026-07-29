/**
 * The placement rule behind `core/dom/domGuard`.
 *
 * The regression is a real production crash — a `boundary` beacon from the
 * shipped 1.0.0 build (2026-07-29): "Failed to execute 'insertBefore' on 'Node':
 * The node before which the new node is to be inserted is not a child of this
 * node.", with Preact's `insert` ← `diffChildren` as its top frames. Preact
 * remembers the sibling to place the next node before; an in-page translator
 * moves that text node into a `<font>` wrapper, and the next render hands
 * `insertBefore` a reference node whose parent is now the wrapper.
 *
 * These cover the two decisions the guard makes — *is* this the failing shape,
 * and *where* should the node go instead — against plain node-shaped objects, so
 * the suite stays in the DOM-free Node environment the rest of the core uses.
 * The end-to-end behaviour (a real Preact render over a translator-rewritten
 * tree) was verified against the shipped vendor bundle in a browser; what can
 * regress silently here is the rule, and that is what is pinned.
 */

import { describe, expect, it } from "vitest";
import { isStaleReference, resolveInsertAnchor } from "@/core/dom/domGuard";

/** A node-shaped object: enough for the rules under test, and mutable so a tree
 *  can be rewritten the way a translator rewrites the real one. */
interface FakeNode {
  nodeType: number;
  nodeName: string;
  parentNode: FakeNode | null;
}

function node(nodeName: string, parentNode: FakeNode | null = null): FakeNode {
  return { nodeType: nodeName === "#text" ? 3 : 1, nodeName, parentNode };
}

/** The exact shape the translator leaves: `parent > font > text`, where `text`
 *  is the very node Preact still points at. */
function translated(): { parent: FakeNode; font: FakeNode; text: FakeNode } {
  const parent = node("DIV");
  const font = node("FONT", parent);
  const text = node("#text", font);
  return { parent, font, text };
}

describe("isStaleReference", () => {
  it("is true for the node a translator re-parented — the production crash", () => {
    const { parent, text } = translated();
    expect(isStaleReference(parent, text)).toBe(true);
  });

  it("is false for an ordinary child, so correct renders take the native path", () => {
    const parent = node("DIV");
    expect(isStaleReference(parent, node("SPAN", parent))).toBe(false);
  });

  it("is false for null/undefined — `insertBefore(node, null)` legitimately appends", () => {
    const parent = node("DIV");
    expect(isStaleReference(parent, null)).toBe(false);
    expect(isStaleReference(parent, undefined)).toBe(false);
  });

  it("is false for a value that isn't node-shaped, so a caller bug still throws", () => {
    const parent = node("DIV");
    expect(isStaleReference(parent, {})).toBe(false);
    expect(isStaleReference(parent, "span")).toBe(false);
    expect(isStaleReference(parent, { parentNode: null })).toBe(false);
  });

  it("is true for a fully detached node — the same class of stale pointer", () => {
    const parent = node("DIV");
    expect(isStaleReference(parent, node("SPAN", null))).toBe(true);
  });
});

describe("resolveInsertAnchor", () => {
  it("returns the wrapper standing where the text was, preserving order", () => {
    // The whole reason not to just append: the wrapper occupies the position the
    // text node used to, so a conditional leading icon still lands *before* its
    // label instead of after it.
    const { parent, font, text } = translated();
    expect(resolveInsertAnchor(parent, text)).toBe(font);
  });

  it("climbs however deep the rewrite nested the node", () => {
    const parent = node("DIV");
    const outer = node("FONT", parent);
    const inner = node("FONT", outer);
    const text = node("#text", inner);
    expect(resolveInsertAnchor(parent, text)).toBe(outer);
  });

  it("returns null (append) when the reference is detached", () => {
    const parent = node("DIV");
    expect(resolveInsertAnchor(parent, node("SPAN", null))).toBeNull();
  });

  it("returns null (append) when the reference lives in an unrelated tree", () => {
    const parent = node("DIV");
    const elsewhere = node("DIV");
    const stray = node("SPAN", elsewhere);
    expect(resolveInsertAnchor(parent, stray)).toBeNull();
  });
});
