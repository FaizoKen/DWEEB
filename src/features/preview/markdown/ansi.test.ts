import { describe, expect, it } from "vitest";
import {
  ANSI_COLOR_NAMES,
  ANSI_PALETTES,
  ansiCodesFor,
  ansiColorCss,
  ansiSegmentStyle,
  encodeAnsi,
  isAnsiLanguage,
  parseAnsi,
  usesExtendedAnsi,
  type AnsiSegment,
} from "./ansi";

const ESC = "\u001b";
const ash = ANSI_PALETTES.ash;

/** Text and the one property under test, per run. */
function runs(source: string, pick: (s: AnsiSegment) => unknown) {
  return parseAnsi(source).map((s) => [s.text, pick(s)]);
}

describe("parseAnsi — the behaviour of Discord's renderer (measured 2026-10-16)", () => {
  it("strips the sequences and keeps the text between them", () => {
    expect(parseAnsi(`${ESC}[31mred${ESC}[0m plain`).map((s) => s.text)).toEqual(["red", " plain"]);
  });

  it("reads the basic, bright and background colors", () => {
    const [fg, bright, bg, brightBg] = parseAnsi(
      `${ESC}[31ma${ESC}[0;91mb${ESC}[0;44mc${ESC}[0;107md`,
    );
    expect(fg?.fg).toEqual({ kind: "named", index: 1 });
    expect(bright?.fg).toEqual({ kind: "named", index: 9 });
    expect(bg?.bg).toEqual({ kind: "named", index: 4 });
    expect(brightBg?.bg).toEqual({ kind: "named", index: 15 });
  });

  it("combines several codes in one sequence", () => {
    const [seg] = parseAnsi(`${ESC}[1;4;32;40mx`);
    expect(seg).toMatchObject({
      bold: true,
      underline: true,
      fg: { kind: "named", index: 2 },
      bg: { kind: "named", index: 0 },
    });
  });

  it("applies every reset before every set inside one sequence", () => {
    // A terminal would end this uncolored; Discord's parser ends it red.
    expect(runs(`${ESC}[31;0mx`, (s) => s.fg)).toEqual([["x", { kind: "named", index: 1 }]]);
  });

  it("treats an empty parameter list as no change, not as a reset", () => {
    expect(runs(`${ESC}[31ma${ESC}[mb`, (s) => s.fg)).toEqual([
      ["a", { kind: "named", index: 1 }],
      ["b", { kind: "named", index: 1 }],
    ]);
  });

  it("reads 24-bit RGB and the 256-color table for text and background", () => {
    const [rgb, table] = parseAnsi(`${ESC}[38;2;255;128;0ma${ESC}[0;48;5;196mb`);
    expect(rgb?.fg).toEqual({ kind: "rgb", rgb: [255, 128, 0] });
    expect(table?.bg).toEqual({ kind: "table", index: 196 });
  });

  it("drops a malformed RGB color but still consumes its arguments", () => {
    // "1" sits in the RGB slot, so it must not turn on bold.
    const [seg] = parseAnsi(`${ESC}[38;2;1;x;0mx`);
    expect(seg).toMatchObject({ fg: null, bold: false });
  });

  it("supports italic, strikethrough and overline, and their resets", () => {
    const [on, off] = parseAnsi(`${ESC}[3;9;53ma${ESC}[23;29;55mb`);
    expect(on).toMatchObject({ italic: true, strike: true, overline: true });
    expect(off).toMatchObject({ italic: false, strike: false, overline: false });
  });

  it("turns bold off with 22 (the dim reset), not just 21", () => {
    expect(runs(`${ESC}[1ma${ESC}[22mb`, (s) => s.bold)).toEqual([
      ["a", true],
      ["b", false],
    ]);
  });

  it("resets only the color with 39 and 49", () => {
    const [, after] = parseAnsi(`${ESC}[1;31;42ma${ESC}[39;49mb`);
    expect(after).toMatchObject({ fg: null, bg: null, bold: true });
  });

  it("ignores blink and never draws dim, reverse or hidden", () => {
    const [seg] = parseAnsi(`${ESC}[2;5;7;8mx`);
    expect(seg && ansiSegmentStyle(seg, ash)).toBeNull();
  });

  it("removes non-SGR control sequences and keeps a lone ESC as text", () => {
    expect(parseAnsi(`a${ESC}[2Kb${ESC}c`).map((s) => s.text)).toEqual(["a", `b${ESC}c`]);
  });

  it("carries the style across newlines", () => {
    expect(runs(`${ESC}[34mone\ntwo`, (s) => s.fg)).toEqual([
      ["one\ntwo", { kind: "named", index: 4 }],
    ]);
  });
});

describe("ansiColorCss", () => {
  it("follows the reader's theme for named colors", () => {
    expect(ansiColorCss({ kind: "named", index: 1 }, ANSI_PALETTES.ash)).toBe("#ec6361");
    expect(ansiColorCss({ kind: "named", index: 1 }, ANSI_PALETTES.onyx)).toBe("#ca2b37");
  });

  it("clamps RGB channels to 0-255", () => {
    expect(ansiColorCss({ kind: "rgb", rgb: [300, -4, 15] }, ash)).toBe("#ff000f");
  });

  it("maps the xterm 256-color table: theme colors, cube, then grays", () => {
    expect(ansiColorCss({ kind: "table", index: 9 }, ash)).toBe(ash[9]);
    expect(ansiColorCss({ kind: "table", index: 16 }, ash)).toBe("#000000");
    expect(ansiColorCss({ kind: "table", index: 196 }, ash)).toBe("#ff0000");
    expect(ansiColorCss({ kind: "table", index: 231 }, ash)).toBe("#ffffff");
    expect(ansiColorCss({ kind: "table", index: 232 }, ash)).toBe("#080808");
    expect(ansiColorCss({ kind: "table", index: 255 }, ash)).toBe("#eeeeee");
    expect(ansiColorCss({ kind: "table", index: 256 }, ash)).toBeUndefined();
  });
});

describe("ansiSegmentStyle", () => {
  it("combines the decorations into one text-decoration-line", () => {
    const [seg] = parseAnsi(`${ESC}[1;3;4;9;53;31;47mx`);
    expect(seg && ansiSegmentStyle(seg, ash)).toEqual({
      color: ash[1],
      backgroundColor: ash[7],
      fontWeight: "bold",
      fontStyle: "italic",
      textDecorationLine: "underline line-through overline",
    });
  });
});

describe("usesExtendedAnsi", () => {
  it("accepts what the older renderer draws", () => {
    expect(usesExtendedAnsi(`${ESC}[1;4;31;40mx${ESC}[0m`)).toBe(false);
    expect(usesExtendedAnsi("no escapes at all")).toBe(false);
  });

  it("flags bright, 256, RGB, italic, strikethrough and partial resets", () => {
    for (const params of ["91", "38;5;196", "48;2;1;2;3", "3", "9", "53", "22", "39"]) {
      expect(usesExtendedAnsi(`${ESC}[${params}mx`)).toBe(true);
    }
  });
});

describe("encodeAnsi", () => {
  const plain = {
    fg: null,
    bg: null,
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    overline: false,
  };

  it("leaves unstyled text bare and closes a styled block with a reset", () => {
    expect(encodeAnsi([{ ...plain, text: "hi" }])).toBe("hi");
    expect(
      encodeAnsi([
        { ...plain, text: "a" },
        { ...plain, text: "b", bold: true, fg: { kind: "named", index: 1 } },
        { ...plain, text: "c" },
      ]),
    ).toBe(`a${ESC}[1;31mb${ESC}[0mc`);
  });

  it("resets and sets in one sequence when the style changes", () => {
    expect(
      encodeAnsi([
        { ...plain, text: "a", fg: { kind: "named", index: 1 } },
        { ...plain, text: "b", bg: { kind: "named", index: 12 } },
      ]),
    ).toBe(`${ESC}[31ma${ESC}[0;104mb${ESC}[0m`);
  });

  it("writes bright, 256 and RGB colors in Discord's forms", () => {
    expect(ansiCodesFor({ ...plain, fg: { kind: "named", index: 9 } })).toEqual(["91"]);
    expect(ansiCodesFor({ ...plain, fg: { kind: "table", index: 208 } })).toEqual([
      "38",
      "5",
      "208",
    ]);
    expect(ansiCodesFor({ ...plain, bg: { kind: "rgb", rgb: [1, 2, 3] } })).toEqual([
      "48",
      "2",
      "1",
      "2",
      "3",
    ]);
  });

  it("round-trips through parseAnsi for any mix of styles", () => {
    // Seeded so a failure reproduces.
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const color = () =>
      [
        null,
        { kind: "named" as const, index: rand(16) },
        { kind: "rgb" as const, rgb: [rand(256), rand(256), rand(256)] as const },
        { kind: "table" as const, index: rand(256) },
      ][rand(4)]!;
    for (let i = 0; i < 300; i++) {
      const segments = Array.from({ length: 1 + rand(6) }, () => ({
        text: ["a", "b c", "\n", "xyz"][rand(4)]!,
        fg: color(),
        bg: color(),
        bold: rand(2) === 1,
        italic: rand(2) === 1,
        underline: rand(2) === 1,
        strike: rand(2) === 1,
        overline: rand(2) === 1,
      }));
      const parsed = parseAnsi(encodeAnsi(segments));
      expect(parsed.map((s) => s.text).join("")).toBe(segments.map((s) => s.text).join(""));
      // Every character keeps its style.
      const styleAt = (list: AnsiSegment[]) =>
        list.flatMap((s) => [...s.text].map(() => JSON.stringify(ansiCodesFor(s))));
      expect(styleAt(parsed)).toEqual(styleAt(segments));
    }
  });

  it("stays inside what the older renderer draws when only basic styles are used", () => {
    const encoded = encodeAnsi([
      { ...plain, text: "a", bold: true, underline: true, fg: { kind: "named", index: 2 } },
      { ...plain, text: "b", bg: { kind: "named", index: 5 } },
    ]);
    expect(usesExtendedAnsi(encoded)).toBe(false);
  });
});

describe("palettes and language tag", () => {
  it("has a full 16-color palette per theme, in code order", () => {
    expect(ANSI_COLOR_NAMES).toHaveLength(16);
    for (const palette of Object.values(ANSI_PALETTES)) {
      expect(palette).toHaveLength(16);
      for (const color of palette) expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("matches the tag case-insensitively", () => {
    expect(isAnsiLanguage("ansi")).toBe(true);
    expect(isAnsiLanguage("ANSI")).toBe(true);
    expect(isAnsiLanguage("ansii")).toBe(false);
    expect(isAnsiLanguage(null)).toBe(false);
  });
});
