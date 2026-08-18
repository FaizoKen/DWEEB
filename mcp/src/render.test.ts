import { describe, expect, it } from "vitest";

import { ButtonStyle, ComponentType, SeparatorSpacing } from "@/core/schema/types";
import { attachEditorFields } from "@/core/serialization/normalize";
import { TEMPLATES } from "@/data/presets";

import { renderOutline } from "./render";

const editor = attachEditorFields;

describe("renderOutline", () => {
  it("states the message's size and settings before the tree", () => {
    const outline = renderOutline(
      editor({
        username: "Announcer",
        thread_name: "Patch notes",
        flags: (1 << 15) | (1 << 12),
        components: [{ type: ComponentType.TextDisplay, content: "hello" }],
      }),
    );
    expect(outline).toContain("1 top-level · 1 components total");
    expect(outline).toContain('Posts as: "Announcer"');
    expect(outline).toContain('Forum post title: "Patch notes"');
    expect(outline).toContain("Silent send");
  });

  it("indents by nesting and names the accent colour in hex", () => {
    const outline = renderOutline(
      editor({
        components: [
          {
            type: ComponentType.Container,
            accent_color: 0x5865f2,
            components: [
              { type: ComponentType.TextDisplay, content: "# Title\nBody" },
              { type: ComponentType.Separator, divider: true, spacing: SeparatorSpacing.Large },
            ],
          },
        ],
      }),
    );
    expect(outline).toContain("Container — accent #5865F2");
    expect(outline).toContain("  ¶ Text");
    // Multi-line content keeps its line breaks, indented under its component.
    expect(outline).toContain("    # Title\n    Body");
    expect(outline).toContain("Separator — divider, large spacing");
  });

  // Getting a button's kind wrong is the single most common Components V2
  // mistake, so the outline says the style and the target for every one.
  it("distinguishes a link button from an interactive one", () => {
    const outline = renderOutline(
      editor({
        components: [
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.Button,
                style: ButtonStyle.Link,
                label: "Docs",
                url: "https://example.test/docs",
              },
              {
                type: ComponentType.Button,
                style: ButtonStyle.Danger,
                label: "Stop",
                custom_id: "stop_it",
                disabled: true,
              },
            ],
          },
        ],
      }),
    );
    expect(outline).toContain("[Docs] · link · → https://example.test/docs");
    expect(outline).toContain('[Stop] · red · custom_id "stop_it" · disabled');
  });

  it("lists a string select's options and the range it accepts", () => {
    const outline = renderOutline(
      editor({
        components: [
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.StringSelect,
                custom_id: "pick",
                placeholder: "Choose",
                min_values: 1,
                max_values: 2,
                options: [
                  { label: "Red", value: "r", description: "warm" },
                  { label: "Blue", value: "b", default: true },
                ],
              },
            ],
          },
        ],
      }),
    );
    expect(outline).toContain("picks options");
    expect(outline).toContain("choose 1–2");
    expect(outline).toContain('1. Red · value "r" · "warm"');
    expect(outline).toContain("selected by default");
  });

  it("shows a section's texts and its accessory", () => {
    const outline = renderOutline(
      editor({
        components: [
          {
            type: ComponentType.Section,
            components: [{ type: ComponentType.TextDisplay, content: "Side by side" }],
            accessory: {
              type: ComponentType.Thumbnail,
              media: { url: "https://example.test/i.png" },
              description: "art",
            },
          },
        ],
      }),
    );
    expect(outline).toContain("accessory:");
    expect(outline).toContain('Thumbnail — https://example.test/i.png · alt "art"');
  });

  // The outline is for reading shape; a single text block may legally hold the
  // whole 4000-character budget and would drown everything else.
  it("elides a very long text block and says how much it dropped", () => {
    const outline = renderOutline(
      editor({ components: [{ type: ComponentType.TextDisplay, content: "x".repeat(1000) }] }),
    );
    expect(outline).toContain("(+400 more characters)");
    expect(outline.length).toBeLessThan(1000);
  });

  it("says plainly when a message has nothing in it", () => {
    expect(renderOutline(editor({ components: [] }))).toContain("no components");
  });

  it("renders every built-in template without throwing", () => {
    for (const template of TEMPLATES) {
      expect(() => renderOutline(template.message), template.id).not.toThrow();
      expect(renderOutline(template.message).length).toBeGreaterThan(0);
    }
  });
});
