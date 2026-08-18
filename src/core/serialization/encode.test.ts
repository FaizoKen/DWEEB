import { describe, expect, it } from "vitest";

import { decodeJson, decodeShare, encodeJson, encodeShare, type DecodeResult } from "./encode";
import { stripEditorFields, attachEditorFields } from "./normalize";
import { CURRENT_VERSION, migrate } from "./version";
import { FIXTURES, richMessage, simpleTextMessage } from "@/test/fixtures";
import { ButtonStyle, ComponentType, type WebhookMessage } from "@/core/schema/types";
import { validateMessage } from "@/core/schema/validation";

/** Narrow a DecodeResult to its ok branch or fail the test with the error. */
function unwrap(result: DecodeResult): WebhookMessage {
  if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`);
  return result.message;
}

describe("encodeShare / decodeShare round-trip", () => {
  for (const [name, build] of Object.entries(FIXTURES)) {
    it(`round-trips the "${name}" fixture through its wire form`, () => {
      const original = build();
      const token = encodeShare(original);
      const decoded = decodeShare(token);

      expect(decoded.ok).toBe(true);
      // The editor ids are reassigned on decode, so equality is asserted on the
      // canonical wire form (ids stripped, flags computed) — the actual contract.
      expect(stripEditorFields(unwrap(decoded))).toEqual(stripEditorFields(original));
    });
  }

  it("carries the current version prefix", () => {
    const token = encodeShare(simpleTextMessage());
    expect(token.startsWith(`${CURRENT_VERSION}.`)).toBe(true);
  });

  it("re-attaches fresh editor ids to every decoded component", () => {
    const decoded = unwrap(decodeShare(encodeShare(richMessage())));
    for (const top of decoded.components) {
      expect(typeof top._id).toBe("string");
      expect(top._id.length).toBeGreaterThan(0);
    }
  });

  it("round-trips the silent-send flag via the wire `flags` bit", () => {
    const decoded = unwrap(decodeShare(encodeShare(richMessage())));
    // richMessage sets suppress_notifications: true → flag 1<<12 → decoded back.
    expect(decoded.suppress_notifications).toBe(true);
  });
});

describe("decodeShare error handling", () => {
  it("rejects a token with no version separator", () => {
    const r = decodeShare("N4Igxgokjdeflate");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/version prefix/i);
  });

  it("rejects a token whose separator is at index 0", () => {
    const r = decodeShare(".abc");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/version prefix/i);
  });

  it("rejects a non-numeric version", () => {
    const r = decodeShare("x.abc");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/non-numeric version/i);
  });

  it("rejects a body that cannot be decompressed", () => {
    const r = decodeShare("1.!!!not-valid-lz-string!!!");
    expect(r.ok).toBe(false);
  });

  it("rejects a future version with an upgrade message rather than corrupting data", () => {
    const body = encodeShare(simpleTextMessage()).split(".").slice(1).join(".");
    const r = decodeShare(`9.${body}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/newer version/i);
  });

  it("rejects a zero / unsupported version", () => {
    const body = encodeShare(simpleTextMessage()).split(".").slice(1).join(".");
    const r = decodeShare(`0.${body}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unsupported share version/i);
  });
});

describe("encodeJson / decodeJson", () => {
  it("produces indented JSON with no editor ids and a computed flags field", () => {
    const json = encodeJson(richMessage());
    expect(json).toContain("\n  "); // indented
    expect(json).not.toContain('"_id"'); // editor id key stripped (not custom_id)
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed.flags).toBe(36864); // IS_COMPONENTS_V2 | SUPPRESS_NOTIFICATIONS
  });

  it("re-imports its own JSON export losslessly", () => {
    const original = richMessage();
    const decoded = decodeJson(encodeJson(original));
    expect(decoded.ok).toBe(true);
    expect(stripEditorFields(unwrap(decoded))).toEqual(stripEditorFields(original));
  });

  it("reports invalid JSON without throwing", () => {
    const r = decodeJson("{ not json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/invalid json/i);
  });

  it("rejects a payload missing its components array", () => {
    const r = decodeJson(JSON.stringify({ username: "x" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/components/i);
  });
});

describe("normalize round-trip invariants", () => {
  it("does not emit message_reference on the wire (webhook execute rejects it)", () => {
    const msg: WebhookMessage = {
      ...simpleTextMessage(),
      message_reference: { message_id: "123456789012345678" },
    };
    const wire = stripEditorFields(msg) as Record<string, unknown>;
    expect(wire.message_reference).toBeUndefined();
  });

  it("lifts the suppress-notifications flag bit back into the editor field", () => {
    const attached = attachEditorFields({
      components: [{ type: ComponentType.TextDisplay, content: "hi" }],
      flags: 36864,
    });
    expect(attached.suppress_notifications).toBe(true);
  });
});

/**
 * The import boundary is the only thing standing between a hand-written payload
 * and a schema layer that dereferences `node.components`, `node.accessory`,
 * `select.options` and `media.url` with no guard. A payload omitting one of
 * those used to reach those consumers as `undefined` and throw a bare TypeError
 * — in prod (2026-07-26) `countCharacters` threw "Cannot use 'in' operator to
 * search for 'content' in undefined" out of the JSON-import click handler, so
 * Import silently did nothing and the uncaught error paged the maintainer.
 */
describe("attachEditorFields — structurally incomplete payloads", () => {
  it("refuses a section with no accessory, with a reason the panel can show", () => {
    const result = decodeJson(
      JSON.stringify({
        components: [
          {
            type: ComponentType.Section,
            components: [{ type: ComponentType.TextDisplay, content: "hi" }],
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/accessory/i);
  });

  it.each([
    ["container", ComponentType.Container],
    ["action row", ComponentType.ActionRow],
  ])("fills a missing `components` array on a %s", (_name, type) => {
    const attached = attachEditorFields({ components: [{ type }] });
    expect((attached.components[0] as unknown as { components: unknown[] }).components).toEqual([]);
  });

  it("fills a missing `components` array on a section that does have an accessory", () => {
    const attached = attachEditorFields({
      components: [
        {
          type: ComponentType.Section,
          accessory: { type: ComponentType.Thumbnail, media: { url: "https://x.test/a.png" } },
        },
      ],
    });
    expect((attached.components[0] as unknown as { components: unknown[] }).components).toEqual([]);
  });

  it("fills a missing `options` array on a string select", () => {
    const attached = attachEditorFields({
      components: [
        {
          type: ComponentType.ActionRow,
          components: [{ type: ComponentType.StringSelect, custom_id: "s" }],
        },
      ],
    });
    const row = attached.components[0] as unknown as { components: Array<{ options: unknown[] }> };
    expect(row.components[0]!.options).toEqual([]);
  });

  it("fills missing media on a thumbnail, a file, and a gallery item", () => {
    const attached = attachEditorFields({
      components: [
        { type: ComponentType.Thumbnail },
        { type: ComponentType.File },
        { type: ComponentType.MediaGallery, items: [{}, "not-an-object"] },
      ],
    });
    const [thumb, file, gallery] = attached.components as unknown as [
      { media: { url: string } },
      { file: { url: string } },
      { items: Array<{ media: { url: string } }> },
    ];
    expect(thumb.media).toEqual({ url: "" });
    expect(file.file).toEqual({ url: "" });
    // Every item ends up media-bearing, including one that wasn't even an object.
    expect(gallery.items.map((i) => i.media)).toEqual([{ url: "" }, { url: "" }]);
  });

  it("fills a missing `items` array on a media gallery", () => {
    const attached = attachEditorFields({ components: [{ type: ComponentType.MediaGallery }] });
    expect((attached.components[0] as unknown as { items: unknown[] }).items).toEqual([]);
  });

  // Same bug one layer down: `validateNode` reads `content.trim()` and
  // `validateButton` hands `url` to `containsPlaceholder`, both unguarded, so
  // either omission threw a TypeError out of the *live* validator — which runs
  // on every keystroke — instead of reporting the empty field.
  it("fills a missing `content` on a text display", () => {
    const attached = attachEditorFields({ components: [{ type: ComponentType.TextDisplay }] });
    expect((attached.components[0] as unknown as { content: string }).content).toBe("");
    expect(() => validateMessage(attached)).not.toThrow();
    expect(validateMessage(attached).issues.map((i) => i.code)).toContain("TEXT_EMPTY");
  });

  it("fills a missing `url` on a link button", () => {
    const attached = attachEditorFields({
      components: [
        {
          type: ComponentType.ActionRow,
          components: [{ type: ComponentType.Button, style: ButtonStyle.Link, label: "Go" }],
        },
      ],
    });
    const row = attached.components[0] as unknown as { components: Array<{ url: string }> };
    expect(row.components[0]!.url).toBe("");
    expect(() => validateMessage(attached)).not.toThrow();
    expect(validateMessage(attached).issues.map((i) => i.code)).toContain("BUTTON_URL_INVALID");
  });

  it("leaves a well-formed payload untouched", () => {
    const original = richMessage();
    const attached = attachEditorFields(stripEditorFields(original));
    expect(stripEditorFields(attached)).toEqual(stripEditorFields(original));
  });
});

describe("migrate", () => {
  it("returns the payload unchanged at the current version", () => {
    const payload = { components: [] };
    expect(migrate(1, payload)).toBe(payload);
  });

  it("throws on a future version", () => {
    expect(() => migrate(CURRENT_VERSION + 1, {})).toThrow(/newer version/i);
  });

  it("throws on a non-positive version", () => {
    expect(() => migrate(0, {})).toThrow(/unsupported/i);
  });
});
