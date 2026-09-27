/**
 * Markdown parser contract tests for the Discord quirks the preview must
 * mirror. Every rule here was verified against the live Discord client's
 * rendered DOM (2026-07 refresh) — see the fidelity notes in AGENTS.md.
 */

import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, type InlineNode } from "./parse";
import { formatTimestamp, TIMESTAMP_STYLES } from "./timestamp";

const kinds = (nodes: InlineNode[]) => nodes.map((n) => n.kind);

const text = (nodes: InlineNode[]) =>
  nodes
    .map((n) => {
      if (n.kind === "text" || n.kind === "code") return n.value;
      return "";
    })
    .join("");

describe("italics", () => {
  it("does not italicize `*` with a space after the opener (literal math)", () => {
    const out = parseInline("2 * 3 * 4");
    expect(kinds(out)).toEqual(["text"]);
    expect(text(out)).toBe("2 * 3 * 4");
  });

  it("italicizes `*text *` (closing star may follow a space)", () => {
    const out = parseInline("and *italic *");
    expect(kinds(out)).toContain("italic");
  });

  it("italicizes space-padded underscores", () => {
    const out = parseInline("5 _ 6 _ 7");
    expect(kinds(out)).toEqual(["text", "italic", "text"]);
  });

  it("keeps intra-word underscores literal", () => {
    const out = parseInline("snake_case_word and with_underscores_inside");
    expect(kinds(out)).toEqual(["text"]);
  });
});

describe("code spans", () => {
  it("supports double-backtick spans containing a backtick", () => {
    const out = parseInline("``code with ` inside``");
    expect(out).toEqual([{ kind: "code", value: "code with ` inside" }]);
  });

  it("still parses single-backtick spans", () => {
    const out = parseInline("a `b` c");
    expect(out).toEqual([
      { kind: "text", value: "a " },
      { kind: "code", value: "b" },
      { kind: "text", value: " c" },
    ]);
  });
});

describe("autolinks", () => {
  it("excludes a trailing close-paren", () => {
    const out = parseInline("(https://example.com/wiki)");
    const link = out.find((n) => n.kind === "link");
    expect(link && "href" in link ? link.href : null).toBe("https://example.com/wiki");
  });

  it("excludes trailing commas and periods", () => {
    const out = parseInline("see https://example.com/a, next");
    const link = out.find((n) => n.kind === "link");
    expect(link && "href" in link ? link.href : null).toBe("https://example.com/a");
    expect(text(out)).toContain(", next");
  });

  it("keeps parentheses inside the path", () => {
    const out = parseInline("https://en.wikipedia.org/wiki/A_(b)_c");
    const link = out.find((n) => n.kind === "link");
    expect(link && "href" in link ? link.href : null).toBe("https://en.wikipedia.org/wiki/A_(b)_c");
  });
});

describe("lists", () => {
  it("merges consecutive ordered items into a preceding bullet list (Discord quirk)", () => {
    const ast = parseMarkdown("- a\n- b\n1. c");
    expect(ast.blocks).toHaveLength(1);
    const list = ast.blocks[0]!;
    expect(list.kind).toBe("list");
    if (list.kind === "list") {
      expect(list.ordered).toBe(false);
      expect(list.items).toHaveLength(3);
    }
  });

  it("keeps a standalone ordered list ordered with its start number", () => {
    const ast = parseMarkdown("7. seven\n8. eight");
    const list = ast.blocks[0]!;
    expect(list.kind).toBe("list");
    if (list.kind === "list") {
      expect(list.ordered).toBe(true);
      expect(list.start).toBe(7);
    }
  });
});

describe("bold across lines", () => {
  it("lets `**` spans cross a newline like Discord", () => {
    const out = parseInline("a **b\nc** d");
    expect(kinds(out)).toContain("bold");
  });
});

describe("timestamps", () => {
  it("parses all nine of Discord's style letters, including the later s and S", () => {
    for (const style of ["t", "T", "d", "D", "f", "F", "s", "S", "R"]) {
      const out = parseInline(`<t:1767225600:${style}>`);
      expect(out).toEqual([{ kind: "timestamp", unix: 1767225600, style }]);
    }
  });

  it("defaults a style-less token to f, like Discord", () => {
    expect(parseInline("<t:1767225600>")).toEqual([
      { kind: "timestamp", unix: 1767225600, style: "f" },
    ]);
  });

  it("leaves an unknown style letter as literal text", () => {
    expect(kinds(parseInline("<t:1767225600:x>"))).not.toContain("timestamp");
  });

  // Not a live-Discord observation like the rest of this file — a crash guard.
  // `Date` holds ±8.64e12 s, and past that the renderer's `toISOString()` (and
  // the relative style's formatter) throw: `<t:…>` one digit too long took the
  // whole editor down to the error screen on 2026-09-27.
  it("leaves a moment Date cannot hold as literal text", () => {
    for (const token of [
      "<t:8640000000001:F>",
      "<t:-8640000000001>",
      "<t:99999999999999:F>",
      `<t:${"9".repeat(400)}:R>`, // parseInt makes this one Infinity
    ]) {
      const out = parseInline(token);
      expect(kinds(out)).toEqual(["text"]);
      expect(text(out)).toBe(token);
    }
  });

  it("keeps Date's own limits as timestamps the renderer can draw", () => {
    for (const unix of ["8640000000000", "-8640000000000"]) {
      for (const { code } of TIMESTAMP_STYLES) {
        const [node] = parseInline(`<t:${unix}:${code}>`);
        if (node?.kind !== "timestamp") throw new Error(`<t:${unix}:${code}> was not parsed`);
        // The two calls Markdown.tsx makes for every timestamp node.
        expect(() => new Date(node.unix * 1000).toISOString()).not.toThrow();
        expect(formatTimestamp(node.unix, node.style)).not.toMatch(/invalid/i);
      }
    }
  });
});
