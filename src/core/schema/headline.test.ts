import { describe, expect, it } from "vitest";

import { messageHeadline, stripMarkdownLine } from "./headline";
import { ComponentType, type TopLevelComponent, type WebhookMessage } from "./types";

function text(content: string): TopLevelComponent {
  return { _id: content.slice(0, 8), type: ComponentType.TextDisplay, content } as never;
}

function container(children: TopLevelComponent[]): TopLevelComponent {
  return { _id: "c1", type: ComponentType.Container, components: children } as never;
}

describe("stripMarkdownLine", () => {
  it("drops heading, subtext, quote and list markers", () => {
    expect(stripMarkdownLine("# 📢 Announcement")).toBe("📢 Announcement");
    expect(stripMarkdownLine("-# Posted by the team")).toBe("Posted by the team");
    expect(stripMarkdownLine("> quoted")).toBe("quoted");
    expect(stripMarkdownLine("- 📜 Read the rules")).toBe("📜 Read the rules");
    expect(stripMarkdownLine("2. second")).toBe("second");
  });

  it("removes emphasis but keeps the words, including placeholder tokens", () => {
    expect(stripMarkdownLine("**A quick heads-up** — _really_ ||secret|| `code`")).toBe(
      "A quick heads-up — really secret code",
    );
    expect(stripMarkdownLine("Winners: {winner_count} • Entered: {entries}")).toBe(
      "Winners: {winner_count} • Entered: {entries}",
    );
  });

  it("turns raw mention and emoji syntax into readable text", () => {
    expect(stripMarkdownLine("Hi <@123> and <@&456> in <#789> <:wave:1> [docs](https://x.y)")).toBe(
      "Hi @user and @role in #channel :wave: docs",
    );
  });
});

describe("messageHeadline", () => {
  it("names a message after its first text line and describes it with the next", () => {
    const message: WebhookMessage = {
      components: [
        container([
          text("# 📢 Announcement\n**A quick heads-up for everyone** — here's what's new."),
          text("We just rolled out a big update."),
        ]),
      ],
    };
    expect(messageHeadline(message)).toEqual({
      title: "📢 Announcement",
      snippet: "A quick heads-up for everyone — here's what's new.",
    });
  });

  it("skips blank lines and clips long ones", () => {
    const long = "x".repeat(80);
    const message: WebhookMessage = { components: [text(`\n\n${long}\n\n`), text("second")] };
    const { title, snippet } = messageHeadline(message);
    expect(title).toHaveLength(60);
    expect(title!.endsWith("…")).toBe(true);
    expect(snippet).toBe("second");
  });

  it("returns nulls for a message with no text", () => {
    const message: WebhookMessage = {
      components: [{ _id: "s", type: ComponentType.Separator } as never],
    };
    expect(messageHeadline(message)).toEqual({ title: null, snippet: null });
  });
});
