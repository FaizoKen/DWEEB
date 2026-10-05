import { describe, expect, it } from "vitest";

import { resolvePostedUploads } from "./postedUploads";
import { ComponentType, type WebhookMessage } from "@/core/schema/types";

const UPLOAD = "session://blob-1/shot.png";
const CDN = "https://cdn.discordapp.com/attachments/1/2/shot.png?ex=1";

function message(): WebhookMessage {
  return {
    components: [
      {
        _id: "c",
        type: ComponentType.Container,
        components: [
          {
            _id: "s",
            type: ComponentType.Section,
            components: [{ _id: "t", type: ComponentType.TextDisplay, content: "hi" }],
            accessory: { _id: "th", type: ComponentType.Thumbnail, media: { url: UPLOAD } },
          },
          {
            _id: "g",
            type: ComponentType.MediaGallery,
            items: [
              { _id: "i0", media: { url: "https://example.com/kept.png" } },
              { _id: "i1", media: { url: "session://blob-2/two.png" } },
            ],
          },
        ],
      },
    ],
  } as unknown as WebhookMessage;
}

describe("posted history never keeps a browser-only upload", () => {
  it("takes each upload's CDN URL from Discord's echo at the same position", () => {
    const echo = {
      components: [
        {
          type: 17,
          components: [
            { type: 9, components: [{ type: 10 }], accessory: { type: 11, media: { url: CDN } } },
            { type: 12, items: [{ media: { url: "x" } }, { media: { url: `${CDN}&two` } }] },
          ],
        },
      ],
    };
    const out = resolvePostedUploads(message(), echo);
    const container = out.components[0] as unknown as {
      components: [
        { accessory: { media: { url: string } } },
        { items: Array<{ media: { url: string } }> },
      ];
    };
    expect(container.components[0].accessory.media.url).toBe(CDN);
    expect(container.components[1].items[0]!.media.url).toBe("https://example.com/kept.png");
    expect(container.components[1].items[1]!.media.url).toBe(`${CDN}&two`);
  });

  it("blanks an upload the echo doesn't account for, never keeping the handle", () => {
    const out = resolvePostedUploads(message(), null);
    expect(JSON.stringify(out)).not.toContain("session://");
  });

  it("returns the same message when nothing needs resolving", () => {
    const plain = {
      components: [{ _id: "t", type: ComponentType.TextDisplay, content: "hi" }],
    } as unknown as WebhookMessage;
    expect(resolvePostedUploads(plain, { components: [] })).toBe(plain);
  });
});
