import { describe, expect, it } from "vitest";

import { announcesEdit, extractReply, streamingProse } from "./extractReply";

const FENCE = (json: string) => "```json\n" + json + "\n```";

describe("extractReply", () => {
  it("splits prose from a fenced message payload", () => {
    const raw = `Sure — here you go.\n${FENCE('{"components":[{"type":10,"content":"Hi"}]}')}`;
    const { text, payload } = extractReply(raw);
    expect(text).toBe("Sure — here you go.");
    expect(payload).toEqual({ components: [{ type: 10, content: "Hi" }] });
  });

  it("returns null payload and full prose when no fence parses", () => {
    const { text, payload } = extractReply("I wasn't sure what to change.");
    expect(payload).toBeNull();
    expect(text).toBe("I wasn't sure what to change.");
  });

  it("prefers the LAST message-shaped fence (the contract puts the payload last)", () => {
    const raw = [
      "Before:",
      FENCE('{"components":[{"type":10,"content":"OLD"}]}'),
      "After:",
      FENCE('{"components":[{"type":10,"content":"NEW"}]}'),
    ].join("\n");
    const { text, payload } = extractReply(raw);
    expect(payload).toEqual({ components: [{ type: 10, content: "NEW" }] });
    // Both JSON walls are stripped from the prose, not just the adopted one.
    expect(text).toContain("Before:");
    expect(text).toContain("After:");
    expect(text).not.toContain('"components"');
  });

  it("tolerates trailing commas and comments from cheap models", () => {
    const body = `{
      // the message
      "components": [
        { "type": 10, "content": "https://a.b/c" }, /* keep url intact */
      ],
    }`;
    const { payload } = extractReply(FENCE(body));
    expect(payload).toEqual({ components: [{ type: 10, content: "https://a.b/c" }] });
  });

  it("accepts a bare unfenced object spanning the whole reply", () => {
    const { text, payload } = extractReply('{"components":[]}');
    expect(payload).toEqual({ components: [] });
    expect(text).toBe("");
  });

  it("ignores fences that are JSON but not message-shaped", () => {
    const raw = `Example config:\n${FENCE('{"foo": 1}')}`;
    const { text, payload } = extractReply(raw);
    expect(payload).toBeNull();
    expect(text).toBe(raw.trim());
  });
});

describe("streamingProse", () => {
  it("hides everything from the first fence onward while streaming", () => {
    expect(streamingProse('Working on it…\n```json\n{"compo')).toBe("Working on it…");
  });

  it("passes through fenceless text", () => {
    expect(streamingProse("Just chatting")).toBe("Just chatting");
  });
});

describe("announcesEdit", () => {
  // The two production bubbles that motivated the recovery turn.
  it("catches 'Here's a streamlined version with just the essentials.'", () => {
    expect(
      announcesEdit("Sure thing! Here's a streamlined version with just the essentials."),
    ).toBe(true);
  });

  it("catches 'Here's a pared-down version that keeps the key info…'", () => {
    expect(
      announcesEdit(
        "Sure! Here's a pared-down version that keeps the key info and a single “Apply Now” button.",
      ),
    ).toBe(true);
  });

  it("catches first-person edit claims", () => {
    expect(announcesEdit("I've simplified the layout and removed the second button.")).toBe(true);
    expect(announcesEdit("Done! All set with the shorter copy.")).toBe(true);
  });

  it("does not fire on questions or plain explanations", () => {
    expect(announcesEdit("Should I remove the second button?")).toBe(false);
    expect(announcesEdit("A container groups children behind a colored accent stripe.")).toBe(
      false,
    );
    expect(announcesEdit("")).toBe(false);
  });
});
