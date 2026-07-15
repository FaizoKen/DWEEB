import { afterEach, describe, expect, it, vi } from "vitest";
import { captureSeoAcquisition, parseSeoEntry, stripSeoEntry } from "./acquisition";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SEO acquisition tokens", () => {
  it.each([
    ["?entry=landing%3Adiscord-webhook-builder", "landing", "discord-webhook-builder"],
    [
      "?template=welcome&entry=template%3Adiscord-welcome-message",
      "template",
      "discord-welcome-message",
    ],
    ["?entry=feature%3Adiscord-ticket-bot", "feature", "discord-ticket-bot"],
    ["?entry=guide%3Adiscord-components-v2", "guide", "discord-components-v2"],
  ])("parses a trusted %s token", (search, sourceType, sourceId) => {
    expect(parseSeoEntry(search)).toEqual({ sourceType, sourceId });
  });

  it.each([
    "",
    "?entry=paid:discord-webhook-builder",
    "?entry=guide:",
    "?entry=guide:../../private",
    "?entry=guide:made-up-but-valid-looking",
    "?entry=template:123456789012345678",
    `?entry=guide:${"x".repeat(81)}`,
  ])("rejects an invalid token in %s", (search) => {
    expect(parseSeoEntry(search)).toBeNull();
  });

  it("removes only entry while preserving the template, other query values, and hash", () => {
    expect(
      stripSeoEntry(
        "https://dweeb.faizo.net/?template=welcome&entry=template%3Adiscord-welcome-message&mode=edit#draft",
      ),
    ).toBe("/?template=welcome&mode=edit#draft");
  });

  it("replays a fresh, matching CTA placement after navigation", () => {
    const gtag = vi.fn();
    const replaceState = vi.fn();
    const values = new Map([
      [
        "dweeb:seo-cta",
        JSON.stringify({
          entry: "guide:discord-components-v2",
          location: "hero",
          at: Date.now(),
        }),
      ],
    ]);
    vi.stubGlobal("window", {
      location: new URL("https://dweeb.faizo.net/?entry=guide%3Adiscord-components-v2&intent=json"),
      history: { replaceState },
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        removeItem: (key: string) => values.delete(key),
      },
      gtag,
    });

    captureSeoAcquisition();

    expect(gtag).toHaveBeenNthCalledWith(1, "event", "seo_cta_click", {
      content_type: "guide",
      content_id: "discord-components-v2",
      cta_location: "hero",
    });
    expect(gtag).toHaveBeenNthCalledWith(2, "event", "seo_builder_open", {
      source_type: "guide",
      source_id: "discord-components-v2",
    });
    expect(replaceState).toHaveBeenCalledWith(null, "", "/?intent=json");
    expect(values.size).toBe(0);
  });
});
