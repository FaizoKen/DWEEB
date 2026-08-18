import { describe, expect, it, vi } from "vitest";

import { ComponentType } from "@/core/schema/types";
import { encodeShare } from "@/core/serialization/encode";
import { attachEditorFields } from "@/core/serialization/normalize";

import { loadConfig, type Config } from "./config";
import { reportMessage, resolveMessage, toWire } from "./message";

const config: Config = loadConfig({});
const offline: Config = loadConfig({ DWEEB_PROXY_URL: "" });

const TEXT_MESSAGE = {
  components: [{ type: ComponentType.TextDisplay, content: "# Hello\nA short post." }],
};

function editor(payload: unknown) {
  return attachEditorFields(payload);
}

describe("resolveMessage", () => {
  it("takes the payload object itself", async () => {
    const resolved = await resolveMessage(TEXT_MESSAGE, config);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.source).toBe("object");
    expect(resolved.value.message.components).toHaveLength(1);
  });

  it("takes the payload as a JSON string", async () => {
    const resolved = await resolveMessage(JSON.stringify(TEXT_MESSAGE), config);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.source).toBe("json");
  });

  it("takes a bare share token", async () => {
    const token = encodeShare(editor(TEXT_MESSAGE));
    const resolved = await resolveMessage(token, config);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.source).toBe("share-token");
    expect(toWire(resolved.value.message)).toMatchObject(TEXT_MESSAGE);
  });

  it("takes a full share URL, and ignores other hash params beside it", async () => {
    const token = encodeShare(editor(TEXT_MESSAGE));
    const resolved = await resolveMessage(`https://dweeb.faizo.net/#g=123&s=${token}`, config);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.source).toBe("share-url");
  });

  it("resolves a short link through the proxy", async () => {
    const token = encodeShare(editor(TEXT_MESSAGE));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ token }), { status: 200 }));
    const resolved = await resolveMessage(
      "https://dweeb.faizo.net/s/Ab3xY9",
      config,
      fetchImpl as unknown as typeof fetch,
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.dweeb.faizo.net/api/shortlink/Ab3xY9",
      expect.anything(),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.source).toBe("short-link");
  });

  it("says so rather than hanging when short links are switched off", async () => {
    const resolved = await resolveMessage("https://dweeb.faizo.net/s/Ab3xY9", offline);
    expect(resolved).toEqual({ ok: false, error: expect.stringContaining("DWEEB_PROXY_URL") });
  });

  describe("refuses, with a reason, anything that is not a message", () => {
    it.each([
      ["a number", 42],
      ["an empty string", "   "],
      ["broken JSON", "{ nope"],
      ["a plain sentence", "post my welcome message"],
      ["a link with no token", "https://dweeb.faizo.net/templates/welcome"],
      ["an object with no components", { username: "bot" }],
    ])("%s", async (_name, input) => {
      const resolved = await resolveMessage(input, config);
      expect(resolved.ok).toBe(false);
      if (resolved.ok) return;
      expect(resolved.error.length).toBeGreaterThan(10);
    });
  });

  // `attachEditorFields` refuses a Section with no accessory rather than
  // inventing one; the funnel has to turn that throw into a described failure.
  it("reports a malformed payload instead of throwing", async () => {
    const resolved = await resolveMessage(
      { components: [{ type: ComponentType.Section, components: [] }] },
      config,
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toContain("accessory");
  });
});

describe("reportMessage", () => {
  it("passes a valid message with no errors", () => {
    const report = reportMessage(editor(TEXT_MESSAGE));
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.stats).toEqual({
      top_level_components: 1,
      total_components: 1,
      characters: "# Hello\nA short post.".length,
    });
  });

  // The validator speaks in editor ids, which mean nothing to a caller that
  // only ever saw the wire payload. Every issue has to name a path into it.
  it("names the path of the component at fault", () => {
    const report = reportMessage(
      editor({
        components: [
          {
            type: ComponentType.Container,
            components: [
              { type: ComponentType.TextDisplay, content: "fine" },
              {
                type: ComponentType.ActionRow,
                components: [{ type: ComponentType.Button, style: 5, label: "Broken" }],
              },
            ],
          },
        ],
      }),
    );
    expect(report.ok).toBe(false);
    const issue = report.errors.find((e) => e.path);
    expect(issue?.path).toBe("components[0].components[1].components[0]");
    expect(issue?.component).toBe("Button");
  });

  it("separates what Discord rejects from what it silently ignores", () => {
    const report = reportMessage(
      editor({ ...TEXT_MESSAGE, tts: true, applied_tags: ["123456789012345678"] }),
    );
    expect(report.ok).toBe(true);
    expect(report.warnings.length).toBeGreaterThan(0);
    // `tts` is accepted and does nothing on a V2 message — that is a
    // requirement note, not a rejection.
    expect(report.requirements.map((r) => r.kind)).toContain("tts_noop");
  });

  it("reports the interactive components that need an app-owned webhook", () => {
    const report = reportMessage(
      editor({
        components: [
          {
            type: ComponentType.ActionRow,
            components: [{ type: ComponentType.Button, style: 1, label: "Click", custom_id: "go" }],
          },
        ],
      }),
    );
    expect(report.requirements.map((r) => r.kind)).toContain("app_webhook");
  });
});

describe("toWire", () => {
  it("emits the body Discord accepts — no editor ids, flags included", () => {
    const wire = toWire(editor(TEXT_MESSAGE));
    expect(JSON.stringify(wire)).not.toContain("_id");
    // IS_COMPONENTS_V2. Without it Discord parses the body as legacy components.
    expect(wire.flags).toBe(1 << 15);
  });
});
