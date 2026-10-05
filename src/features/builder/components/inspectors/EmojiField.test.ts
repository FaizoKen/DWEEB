import { describe, expect, it } from "vitest";
import type { PartialEmoji } from "@/core/schema/types";
import { EmojiField } from "./EmojiField";

// EmojiField is hook-free, so its element tree can be walked without a DOM:
// find the main "Emoji" input and fire its onChange as typing would.
type VNode = { type: unknown; props: Record<string, unknown> };

function childrenOf(node: VNode): VNode[] {
  const c = node.props.children;
  const list = Array.isArray(c) ? c : [c];
  return list.filter((x): x is VNode => !!x && typeof x === "object" && "props" in x);
}

function typeInto(emoji: PartialEmoji | undefined, value: string): PartialEmoji | undefined {
  let result: PartialEmoji | undefined = emoji;
  const root = EmojiField({ emoji, onChange: (next) => (result = next) }) as unknown as VNode;
  const field = childrenOf(root)[0]!;
  const render = field.props.children as (id: string) => VNode;
  const input = childrenOf(render("emoji-input")).find((n) => n.props.id === "emoji-input")!;
  (input.props.onChange as (e: { currentTarget: { value: string } }) => void)({
    currentTarget: { value },
  });
  return result;
}

describe("EmojiField over a custom emoji", () => {
  const custom: PartialEmoji = { id: "1185234567890123456", name: "wave", animated: true };

  it("clearing the field removes the emoji, hidden id included", () => {
    expect(typeInto(custom, "")).toBeUndefined();
  });

  it("typing a unicode emoji over it switches to that emoji", () => {
    expect(typeInto(custom, "🔥")).toEqual({ name: "🔥" });
  });

  it("editing the alias keeps the custom emoji", () => {
    expect(typeInto(custom, "wave2")).toEqual({
      id: "1185234567890123456",
      name: "wave2",
      animated: true,
    });
  });

  it("a pasted token replaces it outright", () => {
    expect(typeInto(custom, "<:fire:1185234567890123457>")).toEqual({
      id: "1185234567890123457",
      name: "fire",
    });
  });
});
