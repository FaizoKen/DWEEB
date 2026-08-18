import { describe, expect, it } from "vitest";

import { buildPathIndex } from "./traversal";
import { ComponentType, type WebhookMessage } from "./types";
import { attachEditorFields } from "@/core/serialization/normalize";

/**
 * `buildPathIndex` translates the validator's editor-id-keyed issues into paths
 * into the wire payload. Both MCP servers report through it, and the shared
 * validator corpus records those paths, so a path that shifts silently would
 * send a model to edit the wrong component in a message it cannot see.
 */
describe("buildPathIndex", () => {
  it("addresses section texts, accessories, and gallery items", () => {
    const message = attachEditorFields({
      components: [
        {
          type: ComponentType.Section,
          components: [{ type: ComponentType.TextDisplay, content: "hi" }],
          accessory: { type: ComponentType.Thumbnail, media: { url: "https://e.test/i.png" } },
        },
        {
          type: ComponentType.MediaGallery,
          items: [{ media: { url: "https://e.test/a.png" } }],
        },
      ],
    });
    const paths = [...buildPathIndex(message).values()];
    expect(paths).toContain("components[0]");
    expect(paths).toContain("components[0].components[0]");
    expect(paths).toContain("components[0].accessory");
    expect(paths).toContain("components[1]");
    expect(paths).toContain("components[1].items[0]");
  });

  it("addresses a button nested in a row inside a container", () => {
    const message = attachEditorFields({
      components: [
        {
          type: ComponentType.Container,
          components: [
            { type: ComponentType.TextDisplay, content: "hi" },
            {
              type: ComponentType.ActionRow,
              components: [
                { type: ComponentType.Button, style: 5, label: "Go", url: "https://e.test/" },
              ],
            },
          ],
        },
      ],
    });
    expect([...buildPathIndex(message).values()]).toContain(
      "components[0].components[1].components[0]",
    );
  });

  it("survives a section whose accessory is missing", () => {
    // The import boundary refuses such a payload, so this only arrives by
    // another route — and a path builder that threw here would take down the
    // very report meant to explain the problem.
    const message = {
      components: [
        {
          _id: "s",
          type: ComponentType.Section,
          components: [{ _id: "t", type: ComponentType.TextDisplay, content: "hi" }],
        },
      ],
    } as unknown as WebhookMessage;
    expect(() => buildPathIndex(message)).not.toThrow();
    expect(buildPathIndex(message).get("t")).toBe("components[0].components[0]");
  });
});
