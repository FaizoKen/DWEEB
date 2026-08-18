import { describe, expect, it } from "vitest";

import { SCHEMA_GUIDE } from "@/core/ai/systemPrompt";
import { LIMITS } from "@/core/schema/limits";

import { authoringGuide, guideHeadingsPresent, limitsTable, schemaSection } from "./guide";

/**
 * The guide is sliced out of `server/src/ai_prompt.txt`, the one canonical
 * description of the wire format, shared with the Rust proxy and the browser's
 * AI panel. These tests exist so that a change over there fails here rather
 * than quietly halving what this server teaches.
 */
describe("authoringGuide", () => {
  it("still finds the headings it slices by", () => {
    expect(guideHeadingsPresent()).toEqual({ contract: true, shape: true });
  });

  it("keeps the schema, the limits, and the rejection list", () => {
    const guide = authoringGuide();
    expect(guide).toContain("## Message object shape");
    expect(guide).toContain("## Component types");
    expect(guide).toContain("## Hard limits");
    expect(guide).toContain("## Rejections to avoid");
  });

  // The shared template's opening tells a model to answer with a fenced json
  // block, because that is how the *editor* applies a change. Over MCP that
  // instruction competes with calling the tool.
  it("replaces the editor's apply contract with this transport's", () => {
    expect(authoringGuide()).not.toContain("THE APP APPLIES CHANGES ONLY FROM THAT JSON BLOCK");
    expect(authoringGuide()).toContain("## How this server is driven");
    expect(authoringGuide()).toContain("`message` argument of a tool");
  });

  it("falls back to the whole text rather than dropping the schema", () => {
    // `schemaSection` is the half that would be lost; if the heading ever moves
    // it returns everything, which is wrong-but-complete rather than empty.
    expect(schemaSection().length).toBeGreaterThan(1000);
    expect(SCHEMA_GUIDE).toContain(schemaSection());
  });
});

describe("limitsTable", () => {
  it("is the validator's own numbers, not a second copy", () => {
    expect(limitsTable()).toEqual({ ...LIMITS });
  });

  it("hands back a detached copy, so a caller cannot mutate the source", () => {
    const table = limitsTable();
    table.TOTAL_COMPONENTS = 1;
    expect(LIMITS.TOTAL_COMPONENTS).not.toBe(1);
  });
});
