import { describe, expect, it } from "vitest";

import { convertV1Payload, detectV1Fields } from "./v1Import";
import { LIMITS } from "@/core/schema/limits";
import { ComponentType, type TextDisplayComponent } from "@/core/schema/types";

describe("detectV1Fields", () => {
  it("flags each legacy field that is actually present", () => {
    const result = detectV1Fields({
      content: "hi",
      embeds: [{ title: "t" }],
      poll: { question: {} },
      sticker_ids: ["1"],
    });
    expect(result.hasV1Fields).toBe(true);
    expect(result.fields).toEqual(
      expect.arrayContaining(["content", "embeds", "poll", "sticker_ids"]),
    );
  });

  it("ignores empty legacy fields", () => {
    expect(detectV1Fields({ content: "", embeds: [] }).hasV1Fields).toBe(false);
  });

  it("returns false for a non-object", () => {
    expect(detectV1Fields(null).hasV1Fields).toBe(false);
    expect(detectV1Fields("nope").hasV1Fields).toBe(false);
  });
});

describe("convertV1Payload", () => {
  it("prepends `content` as a TextDisplay at the top of the message", () => {
    const { message, notes } = convertV1Payload({ content: "Hello there" });
    const first = message.components[0] as TextDisplayComponent;
    expect(first.type).toBe(ComponentType.TextDisplay);
    expect(first.content).toBe("Hello there");
    expect(notes.some((n) => n.source === "content")).toBe(true);
  });

  it("truncates over-long content and records a note", () => {
    const long = "x".repeat(LIMITS.TEXT_DISPLAY_CONTENT + 50);
    const { message, notes } = convertV1Payload({ content: long });
    const first = message.components[0] as TextDisplayComponent;
    expect(first.content.length).toBe(LIMITS.TEXT_DISPLAY_CONTENT);
    expect(notes.find((n) => n.source === "content")?.message).toMatch(/truncated/i);
  });

  it("converts an embed into a coloured Container carrying its title and description", () => {
    const { message } = convertV1Payload({
      embeds: [{ title: "Patch Notes", description: "Bug fixes.", color: 0xff0000 }],
    });
    const container = message.components.find((c) => c.type === ComponentType.Container);
    expect(container).toBeDefined();
    if (!container || container.type !== ComponentType.Container) return;
    expect(container.accent_color).toBe(0xff0000);
    const text = container.components
      .filter((c): c is TextDisplayComponent => c.type === ComponentType.TextDisplay)
      .map((c) => c.content)
      .join("\n");
    expect(text).toContain("Patch Notes");
    expect(text).toContain("Bug fixes.");
  });

  it("drops a poll with a warning note", () => {
    const { notes } = convertV1Payload({ content: "x", poll: { question: { text: "?" } } });
    const poll = notes.find((n) => n.source === "poll");
    expect(poll?.level).toBe("warning");
  });

  it("drops stickers with a warning note", () => {
    const { notes } = convertV1Payload({ content: "x", stickers: [{ id: "1" }] });
    expect(notes.find((n) => n.source === "stickers")?.level).toBe("warning");
  });

  it("preserves already-present V2 components after the converted content", () => {
    const { message } = convertV1Payload({
      content: "Intro",
      components: [{ type: ComponentType.TextDisplay, content: "Existing V2" }],
    });
    const contents = message.components
      .filter((c): c is TextDisplayComponent => c.type === ComponentType.TextDisplay)
      .map((c) => c.content);
    expect(contents[0]).toBe("Intro");
    expect(contents).toContain("Existing V2");
  });

  it("throws only when the payload is not an object", () => {
    expect(() => convertV1Payload(42)).toThrow();
  });
});
