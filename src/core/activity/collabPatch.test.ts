/**
 * `isWholeDocumentReplace` — how the room tells "someone swapped the whole
 * draft out" (worth telling everyone, naming who) from an ordinary structural
 * edit (which is just collaboration). Every whole-message action re-ids the
 * tree, so the signal is that no node survives — at any depth.
 */

import { describe, expect, it } from "vitest";
import { ComponentType, type WebhookMessage } from "@/core/schema/types";
import { isWholeDocumentReplace } from "./collabPatch";

type Node = Record<string, unknown>;
const text = (id: string, content = "Hello"): Node => ({
  _id: id,
  type: ComponentType.TextDisplay,
  content,
});
const container = (id: string, ...children: Node[]): Node => ({
  _id: id,
  type: ComponentType.Container,
  components: children,
});
const section = (id: string, accessoryId: string, ...texts: Node[]): Node => ({
  _id: id,
  type: ComponentType.Section,
  components: texts,
  accessory: { _id: accessoryId, type: ComponentType.Thumbnail, media: { url: "https://x/y.png" } },
});
const msg = (...components: Node[]): WebhookMessage =>
  ({ components }) as unknown as WebhookMessage;

describe("isWholeDocumentReplace", () => {
  it("flags a draft that shares no node with the one it replaced", () => {
    expect(isWholeDocumentReplace(msg(text("a"), text("b")), msg(text("x"), text("y")))).toBe(true);
  });

  it("counts clearing a non-empty draft as a replace", () => {
    expect(isWholeDocumentReplace(msg(text("a")), msg())).toBe(true);
  });

  it("never counts filling an empty draft — nothing was lost", () => {
    expect(isWholeDocumentReplace(msg(), msg(text("x")))).toBe(false);
    expect(isWholeDocumentReplace(msg(), msg())).toBe(false);
  });

  it("ignores ordinary structural edits that keep any node", () => {
    const before = msg(text("a"), text("b"));
    // Add, remove, reorder.
    expect(isWholeDocumentReplace(before, msg(text("a"), text("b"), text("c")))).toBe(false);
    expect(isWholeDocumentReplace(before, msg(text("b")))).toBe(false);
    expect(isWholeDocumentReplace(before, msg(text("b"), text("a")))).toBe(false);
    // Same ids with edited content are still the same draft.
    expect(isWholeDocumentReplace(before, msg(text("a", "Edited"), text("b")))).toBe(false);
  });

  it("looks at every depth, so wrapping the blocks in a container isn't a replace", () => {
    // A fresh root id, with every old block now nested inside it.
    expect(
      isWholeDocumentReplace(
        msg(text("a"), text("b")),
        msg(container("new", text("a"), text("b"))),
      ),
    ).toBe(false);
    // …and a Section's accessory survives as a node too.
    expect(
      isWholeDocumentReplace(msg(section("s", "thumb", text("t"))), msg(section("s2", "thumb"))),
    ).toBe(false);
    expect(
      isWholeDocumentReplace(
        msg(container("c", section("s", "thumb", text("t")))),
        msg(container("c2", text("u"))),
      ),
    ).toBe(true);
  });

  it("tolerates a malformed peer frame instead of throwing mid-sync", () => {
    const broken = { components: [{ type: ComponentType.Container }] } as unknown as WebhookMessage;
    const noList = {} as unknown as WebhookMessage;
    expect(() => isWholeDocumentReplace(msg(text("a")), broken)).not.toThrow();
    expect(isWholeDocumentReplace(msg(text("a")), noList)).toBe(true);
    expect(isWholeDocumentReplace(noList, msg(text("a")))).toBe(false);
  });
});
