import { describe, expect, it } from "vitest";
import { TEMPLATES } from "@/data/presets";
import { attachEditorFields } from "@/core/serialization/normalize";
import { generateCode } from "@/core/codegen";
import { prepareCodegenInput } from "@/core/codegen/payload";
import {
  buildComponentEmbed,
  componentEmbedScript,
  componentEmbedViolations,
  COMPONENT_EMBED_MAX_BYTES,
  isPreviewMediaUrl,
  scriptSafeJson,
  utf8Bytes,
} from "./componentEmbed";

const IMG = "https://dweeb.faizo.net/media/defaults/banner.jpg";

const linkButton = (label: string, url = "https://example.com/") => ({
  type: 2,
  style: 5,
  label,
  url,
});

describe("component embed", () => {
  it("passes a single Container through, accent and all", () => {
    const embed = buildComponentEmbed([
      {
        type: 17,
        accent_color: 0x5865f2,
        components: [
          { type: 10, content: "## Hello" },
          { type: 14, divider: true, spacing: 1 },
          { type: 1, components: [linkButton("Open")] },
        ],
      },
    ]);
    expect(embed.wrapped).toBe(false);
    expect(embed.omitted).toEqual([]);
    expect(embed.problems).toEqual([]);
    expect(embed.payload).toEqual({
      component: {
        type: 17,
        accent_color: 0x5865f2,
        components: [
          { type: 10, content: "## Hello" },
          { type: 14, divider: true, spacing: 1 },
          {
            type: 1,
            components: [{ type: 2, style: 5, url: "https://example.com/", label: "Open" }],
          },
        ],
      },
    });
    expect(componentEmbedViolations(embed.json)).toEqual([]);
  });

  it("wraps a message with no Container in one, the only shape a preview has", () => {
    const embed = buildComponentEmbed([{ type: 10, content: "Hi" }, { type: 14 }]);
    expect(embed.wrapped).toBe(true);
    expect(embed.payload?.component).toEqual({
      type: 17,
      components: [{ type: 10, content: "Hi" }, { type: 14 }],
    });
  });

  it("keeps the first Container and names what it dropped beside it", () => {
    const embed = buildComponentEmbed([
      { type: 10, content: "outside" },
      { type: 17, components: [{ type: 10, content: "inside" }] },
    ]);
    expect(embed.payload?.component.components).toEqual([{ type: 10, content: "inside" }]);
    expect(embed.omitted.join(" ")).toMatch(/outside the Container/);
  });

  it("leaves out what a preview can't hold, and says so", () => {
    const embed = buildComponentEmbed([
      {
        type: 17,
        components: [
          {
            type: 1,
            components: [
              { type: 2, style: 1, label: "Click", custom_id: "x" },
              linkButton("Docs"),
              { type: 2, style: 5, url: "https://example.com/" }, // no label or emoji
            ],
          },
          { type: 1, components: [{ type: 3, custom_id: "s", options: [] }] },
          { type: 13, file: { url: "attachment://a.pdf" } },
          { type: 17, components: [] },
        ],
      },
    ]);
    const kept = embed.payload!.component.components as Array<Record<string, unknown>>;
    expect(kept).toEqual([
      { type: 1, components: [{ type: 2, style: 5, url: "https://example.com/", label: "Docs" }] },
    ]);
    const notes = embed.omitted.join("\n");
    expect(notes).toMatch(/run an action/);
    expect(notes).toMatch(/neither a label nor an emoji/);
    expect(notes).toMatch(/dropdown menu/);
    expect(notes).toMatch(/A file/);
    expect(notes).toMatch(/can't nest/);
  });

  it("keeps a Section's text when its accessory can't stay", () => {
    const embed = buildComponentEmbed([
      {
        type: 17,
        components: [
          {
            type: 9,
            components: [{ type: 10, content: "With picture" }],
            accessory: { type: 11, media: { url: IMG }, description: "Banner" },
          },
          {
            type: 9,
            components: [{ type: 10, content: "Uploaded picture" }],
            accessory: { type: 11, media: { url: "attachment://cat.png" } },
          },
          {
            type: 9,
            components: [{ type: 10, content: "Action button" }],
            accessory: { type: 2, style: 3, custom_id: "go", label: "Go" },
          },
        ],
      },
    ]);
    expect(embed.payload!.component.components).toEqual([
      {
        type: 9,
        components: [{ type: 10, content: "With picture" }],
        accessory: { type: 11, media: { url: IMG }, description: "Banner" },
      },
      { type: 10, content: "Uploaded picture" },
      { type: 10, content: "Action button" },
    ]);
    expect(embed.omitted.join("\n")).toMatch(/uploaded file/);
  });

  it("caps gallery images at ten across the whole embed", () => {
    const gallery = (n: number) => ({
      type: 12,
      items: Array.from({ length: n }, (_, i) => ({ media: { url: `https://x.test/${i}.png` } })),
    });
    const embed = buildComponentEmbed([{ type: 17, components: [gallery(6), gallery(6)] }]);
    const galleries = embed.payload!.component.components as Array<{ items: unknown[] }>;
    expect(galleries.map((g) => g.items.length)).toEqual([6, 4]);
    expect(embed.omitted.join("\n")).toMatch(/at most 10/);
    expect(componentEmbedViolations(embed.json)).toEqual([]);
  });

  it("accepts only http(s) media in a format Discord plays", () => {
    expect(isPreviewMediaUrl("https://x.test/a.PNG?w=2")).toBe(true);
    expect(isPreviewMediaUrl("http://x.test/clip.webm")).toBe(true);
    expect(isPreviewMediaUrl("https://x.test/page")).toBe(false);
    expect(isPreviewMediaUrl("https://x.test/a.svg")).toBe(false);
    expect(isPreviewMediaUrl("attachment://a.png")).toBe(false);
    expect(isPreviewMediaUrl("javascript:alert(1)//a.png")).toBe(false);
    expect(isPreviewMediaUrl(`https://x.test/${"a".repeat(2050)}.png`)).toBe(false);
  });

  it("can never close its own <script>, and counts bytes as Discord does", () => {
    const embed = buildComponentEmbed([{ type: 10, content: "</script><b>é</b>" }]);
    expect(embed.json).not.toMatch(/<\//);
    expect(JSON.parse(embed.json).component.components[0].content).toBe("</script><b>é</b>");
    // `<` costs six bytes as <; é costs two as raw UTF-8.
    expect(embed.bytes).toBe(utf8Bytes(embed.json));
    expect(scriptSafeJson("é<")).toBe('"é\\u003c"');
    expect(componentEmbedScript(embed.json)).toMatch(
      /^<script id="discord:component-embed" type="application\/json">\{.*\}<\/script>$/,
    );
  });

  it("reports a payload over Discord's 3,000 bytes rather than trimming it", () => {
    const embed = buildComponentEmbed([
      { type: 10, content: "x".repeat(COMPONENT_EMBED_MAX_BYTES) },
    ]);
    expect(embed.payload).not.toBeNull();
    expect(embed.problems.join(" ")).toMatch(/limit is 3,000/);
    expect(componentEmbedViolations(embed.json)).toContain("over 3,000 bytes");
  });

  it("says when nothing in the message can appear", () => {
    const embed = buildComponentEmbed([{ type: 1, components: [{ type: 3, custom_id: "s" }] }]);
    expect(embed.payload).toBeNull();
    expect(embed.problems).toHaveLength(1);
  });

  it("builds a valid payload, or names why not, for every template", () => {
    for (const template of TEMPLATES) {
      const embed = buildComponentEmbed(prepareCodegenInput(template.message).payload.components);
      if (!embed.payload) continue;
      const violations = componentEmbedViolations(embed.json);
      if (embed.problems.length === 0) expect(violations, template.id).toEqual([]);
      // Whatever the size, no key or type outside the rules is ever emitted.
      expect(
        violations.filter((v) => v !== "over 3,000 bytes" && !/components \(max 40\)/.test(v)),
        template.id,
      ).toEqual([]);
    }
  });

  it("is offered as a code-export target", () => {
    const message = attachEditorFields({
      components: [{ type: 17, components: [{ type: 10, content: "Hello" }] }],
    });
    const html = generateCode(message, "linkpreview");
    expect(html).toContain('<script id="discord:component-embed" type="application/json">');
    expect(html).toContain(
      '{"component":{"type":17,"components":[{"type":10,"content":"Hello"}]}}',
    );
    // An HTML comment can't hold "--" before its end.
    const comment = html.slice(html.indexOf("<!--") + 4, html.indexOf("-->"));
    expect(comment).not.toContain("--");
  });
});

describe("componentEmbedViolations", () => {
  const check = (component: unknown) => componentEmbedViolations(JSON.stringify({ component }));

  it("refuses every shape Discord refuses", () => {
    expect(check({ type: 17, components: [] })).toEqual([]);
    expect(check({ type: 10, content: "x" })).toContain("top-level component is not a Container");
    expect(check({ type: 17, components: [{ type: 17, components: [] }] })).toContain(
      "nested Container",
    );
    expect(
      check({
        type: 17,
        components: [{ type: 1, components: [{ ...linkButton("a"), custom_id: "x" }] }],
      }),
    ).toContain('type 2 carries "custom_id"');
    expect(
      check({
        type: 17,
        components: [
          { type: 1, components: [{ type: 2, style: 1, label: "a", url: "https://a.b/" }] },
        ],
      }),
    ).toContain("a button is not link-style");
    expect(
      check({ type: 17, components: [{ type: 13, file: { url: "attachment://a" } }] }),
    ).toContain("type 13 is not allowed");
    expect(componentEmbedViolations("[]")).toContain('not {"component": <Container>}');
    expect(componentEmbedViolations("{")).toContain("not JSON");
  });
});
