/**
 * Prompt-template contract.
 *
 * The instruction template lives in `server/src/ai_prompt.txt` — one canonical
 * copy consumed by BOTH the FE (raw import, for bring-your-own-key providers)
 * and the Rust proxy (`include_str!`, for the built-in relay). Because the file
 * bakes the editor's hard limits in as literal numbers, these tests rebuild the
 * expected phrases from `LIMITS` so a limit change that forgets the template
 * fails loudly here instead of quietly teaching the model stale ceilings.
 * They also pin the assembled prompt's shape to what the server's
 * `build_system` (`server/src/ai.rs`) produces, so every provider — built-in
 * or BYOK — answers under a byte-identical prompt.
 */

import { describe, expect, it } from "vitest";

import { SCHEMA_GUIDE, buildPromptContext, buildSystemPrompt } from "./systemPrompt";
import { LIMITS } from "@/core/schema/limits";
import { attachEditorFields } from "@/core/serialization/normalize";

const MESSAGE = attachEditorFields({
  components: [{ type: 10, content: "Hello" }],
});

describe("the shared instruction template", () => {
  it("carries the current editor limits as baked-in numbers", () => {
    for (const phrase of [
      `Holds EITHER up to ${LIMITS.ACTION_ROW_BUTTONS} buttons OR exactly one select.`,
      `At most ${LIMITS.TOP_LEVEL_COMPONENTS} top-level components; ${LIMITS.TOTAL_COMPONENTS} components total including nested.`,
      `At most ${LIMITS.TOTAL_CHARACTERS} characters of text across the whole message.`,
      `Container: 1–${LIMITS.CONTAINER_CHILDREN} children. Section: 1–${LIMITS.SECTION_TEXTS_MAX} text blocks. Gallery: 1–${LIMITS.GALLERY_ITEMS} items.`,
      `Button label ≤ ${LIMITS.BUTTON_LABEL} chars. String select: 1–${LIMITS.SELECT_OPTIONS} options.`,
      `accent_color is an integer 0–${LIMITS.COLOR_MAX}`,
      `Media Gallery needs 1–${LIMITS.GALLERY_ITEMS} items; String select needs 1–${LIMITS.SELECT_OPTIONS} options with unique values.`,
    ]) {
      expect(SCHEMA_GUIDE).toContain(phrase);
    }
  });

  it("is normalized: no CRLF, no trailing newline", () => {
    expect(SCHEMA_GUIDE).not.toContain("\r");
    expect(SCHEMA_GUIDE).toBe(SCHEMA_GUIDE.trimEnd());
  });
});

describe("buildSystemPrompt", () => {
  it("assembles template + current-message section exactly like the server", () => {
    const prompt = buildSystemPrompt(MESSAGE);
    // Mirror of `build_system` in server/src/ai.rs — keep the two in step.
    const expected =
      `${SCHEMA_GUIDE}\n\n## CURRENT MESSAGE (the editor's live state)\n` +
      "This is the live editor state right now — any json block you emitted earlier " +
      "has already been applied to it. Base your next edit on THIS, not on memory.\n" +
      `\`\`\`json\n${buildPromptContext(MESSAGE)}\n\`\`\``;
    expect(prompt).toBe(expected);
  });

  it("context is strict JSON without editor-internal fields", () => {
    const context = buildPromptContext(MESSAGE);
    const parsed = JSON.parse(context) as { components?: unknown };
    expect(Array.isArray(parsed.components)).toBe(true);
    expect(context).not.toContain('"_id"');
  });
});
