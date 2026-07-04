import { describe, expect, it } from "vitest";

import {
  CORE_PLACEHOLDER_TOKENS,
  collectMessagePlaceholders,
  containsPlaceholder,
  parsePlaceholders,
  sanitizePlaceholderValues,
  substituteMessage,
  substituteText,
} from "./placeholders";
import { ComponentType, type WebhookMessage } from "@/core/schema/types";
import { richMessage, simpleTextMessage } from "@/test/fixtures";

describe("containsPlaceholder", () => {
  it("recognises well-formed lowercase tokens", () => {
    expect(containsPlaceholder("{server}")).toBe(true);
    expect(containsPlaceholder("Welcome to {server_id}!")).toBe(true);
  });

  it("ignores ordinary prose braces and non-token shapes", () => {
    expect(containsPlaceholder("{ this }")).toBe(false);
    expect(containsPlaceholder("{TODO}")).toBe(false);
    expect(containsPlaceholder("no braces here")).toBe(false);
  });
});

describe("substituteText", () => {
  it("replaces known tokens and leaves unknown ones verbatim", () => {
    expect(substituteText("Hi {server}, id {server_id}", { server: "Cool" })).toBe(
      "Hi Cool, id {server_id}",
    );
  });

  it("returns the input unchanged when it has no braces", () => {
    expect(substituteText("plain text", { server: "x" })).toBe("plain text");
  });
});

describe("substituteMessage", () => {
  it("returns the same reference when the map is empty (no needless clone)", () => {
    const m = simpleTextMessage();
    expect(substituteMessage(m, {})).toBe(m);
  });

  it("substitutes user-facing fields without mutating the input", () => {
    const original: WebhookMessage = {
      username: "{server} bot",
      components: [
        { _id: "t", type: ComponentType.TextDisplay, content: "Welcome to {server}!" },
        {
          _id: "row",
          type: ComponentType.ActionRow,
          components: [
            {
              _id: "b",
              type: ComponentType.Button,
              style: 5,
              label: "Visit {server}",
              url: "https://x.test/{server_id}",
            },
          ],
        } as unknown as WebhookMessage["components"][number],
      ],
    };
    const snapshot = JSON.parse(JSON.stringify(original));

    const out = substituteMessage(original, { server: "Cats", server_id: "42" });

    expect(out.username).toBe("Cats bot");
    const text = out.components[0] as { content: string };
    expect(text.content).toBe("Welcome to Cats!");
    const btn = (out.components[1] as { components: Array<{ label: string; url: string }> })
      .components[0];
    expect(btn.label).toBe("Visit Cats");
    expect(btn.url).toBe("https://x.test/42");

    // Purity: the original tree is untouched.
    expect(original).toEqual(snapshot);
  });

  it("never substitutes bot-facing custom_id", () => {
    const m: WebhookMessage = {
      components: [
        {
          _id: "row",
          type: ComponentType.ActionRow,
          components: [
            {
              _id: "b",
              type: ComponentType.Button,
              style: 1,
              label: "{server}",
              custom_id: "{server}",
            },
          ],
        } as unknown as WebhookMessage["components"][number],
      ],
    };
    const out = substituteMessage(m, { server: "Cats" });
    const btn = (out.components[0] as { components: Array<{ label: string; custom_id: string }> })
      .components[0];
    expect(btn.label).toBe("Cats");
    expect(btn.custom_id).toBe("{server}"); // untouched
  });
});

describe("parsePlaceholders", () => {
  it("keeps well-formed entries and clamps the label", () => {
    const parsed = parsePlaceholders([{ token: "prize", label: "P".repeat(80), sample: "TBD" }]);
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]?.token).toBe("prize");
    expect(parsed?.[0]?.label.length).toBeLessThanOrEqual(40);
  });

  it("drops entries that shadow a reserved core token", () => {
    expect(parsePlaceholders([{ token: "server", label: "nope" }])).toBeUndefined();
  });

  it("drops malformed tokens and dedupes", () => {
    const parsed = parsePlaceholders([
      { token: "Bad Token", label: "x" },
      { token: "ok", label: "first" },
      { token: "ok", label: "dupe" },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]?.label).toBe("first");
  });

  it("returns undefined when nothing usable survives", () => {
    expect(parsePlaceholders([{ nope: true }])).toBeUndefined();
    expect(parsePlaceholders("not an array")).toBeUndefined();
  });
});

describe("sanitizePlaceholderValues", () => {
  it("keeps valid token→string pairs", () => {
    expect(sanitizePlaceholderValues({ prize: "Nitro", winners: "3" })).toEqual({
      prize: "Nitro",
      winners: "3",
    });
  });

  it("defangs @everyone / @here so a value cannot ring the channel", () => {
    const out = sanitizePlaceholderValues({ msg: "hey @everyone and @here" });
    expect(out?.msg).not.toContain("@everyone");
    expect(out?.msg).not.toContain("@here");
    // The visible text (sans the injected zero-width space) is preserved.
    expect(out?.msg?.replace(/​/g, "")).toBe("hey @everyone and @here");
  });

  it("drops non-string values and invalid keys", () => {
    expect(sanitizePlaceholderValues({ "Bad Key": "x", n: 5 })).toBeUndefined();
  });
});

describe("collectMessagePlaceholders (core provider)", () => {
  it("resolves core tokens from context and falls back to samples", () => {
    const map = collectMessagePlaceholders(richMessage(), [], {
      serverName: "My Guild",
      serverId: "123",
      channelId: "456",
    });
    expect(map.server).toBe("My Guild");
    expect(map.server_id).toBe("123");
    expect(map.channel_mention).toBe("<#456>");
    // channel name had no context value → falls back to its sample.
    expect(map.channel).toBe("this channel");
  });

  it("exposes the reserved core token set", () => {
    expect(CORE_PLACEHOLDER_TOKENS.has("server")).toBe(true);
    expect(CORE_PLACEHOLDER_TOKENS.has("channel_mention")).toBe(true);
  });
});
