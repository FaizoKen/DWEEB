import { describe, expect, it } from "vitest";
import {
  isInlineActive,
  setHeading,
  toggleBulletList,
  toggleQuote,
  wrapInline,
} from "./markdownActions";

describe("line actions act on the lines the selection covers", () => {
  it("a caret on an empty first line gets the prefix itself", () => {
    // lastIndexOf("\n", -1) finds a newline AT index 0, which resolved the
    // block to the line after the caret and duplicated the newline.
    expect(setHeading({ text: "\nhello", selStart: 0, selEnd: 0 }, "# ").text).toBe("# \nhello");
    expect(toggleQuote({ text: "\nhello", selStart: 0, selEnd: 0 }).text).toBe("> \nhello");
  });

  it("a selection ending just past a newline leaves the next line alone", () => {
    expect(setHeading({ text: "a\nb", selStart: 0, selEnd: 2 }, "# ").text).toBe("# a\nb");
    expect(toggleBulletList({ text: "one\ntwo\nthree", selStart: 0, selEnd: 4 }).text).toBe(
      "- one\ntwo\nthree",
    );
  });

  it("still covers every line a selection spans", () => {
    expect(toggleBulletList({ text: "one\ntwo\nthree", selStart: 0, selEnd: 6 }).text).toBe(
      "- one\n- two\nthree",
    );
    expect(setHeading({ text: "a\nb", selStart: 2, selEnd: 2 }, "## ").text).toBe("a\n## b");
  });
});

describe("italic counts marker runs", () => {
  it("adds italic to bold text instead of stripping the bold", () => {
    const inside = { text: "**bold**", selStart: 2, selEnd: 6 };
    expect(isInlineActive(inside, "*")).toBe(false);
    expect(wrapInline(inside, "*").text).toBe("***bold***");
    const whole = { text: "**bold**", selStart: 0, selEnd: 8 };
    expect(isInlineActive(whole, "*")).toBe(false);
    expect(wrapInline(whole, "*").text).toBe("***bold***");
  });

  it("still removes italic, including from bold italic", () => {
    expect(wrapInline({ text: "*x*", selStart: 1, selEnd: 2 }, "*").text).toBe("x");
    expect(wrapInline({ text: "***x***", selStart: 3, selEnd: 4 }, "*").text).toBe("**x**");
    expect(isInlineActive({ text: "***x***", selStart: 3, selEnd: 4 }, "*")).toBe(true);
  });

  it("leaves every whole-marker toggle as it was", () => {
    expect(wrapInline({ text: "**x**", selStart: 2, selEnd: 3 }, "**").text).toBe("x");
    expect(wrapInline({ text: "x", selStart: 0, selEnd: 1 }, "**").text).toBe("**x**");
    expect(wrapInline({ text: "``x``", selStart: 2, selEnd: 3 }, "`").text).toBe("`x`");
  });
});
