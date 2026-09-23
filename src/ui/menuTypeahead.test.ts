import { describe, expect, it } from "vitest";
import { typeaheadIndex } from "./menuTypeahead";

const MORE = [
  "Share link",
  "Export JSON",
  "Export as code",
  "Restore a message",
  "Watch the intro",
  "Send feedback",
];

describe("typeaheadIndex", () => {
  it("jumps to the first item starting with a typed letter", () => {
    expect(typeaheadIndex(MORE, -1, "w")).toBe(4);
    expect(typeaheadIndex(MORE, 0, "r")).toBe(3);
  });

  it("ignores case and surrounding space in labels", () => {
    expect(typeaheadIndex(["  Undo", "Redo"], -1, "U")).toBe(0);
  });

  it("cycles through items sharing a first letter on repeated presses", () => {
    expect(typeaheadIndex(MORE, -1, "s")).toBe(0);
    expect(typeaheadIndex(MORE, 0, "s")).toBe(5);
    // Wraps back round to the first.
    expect(typeaheadIndex(MORE, 5, "s")).toBe(0);
    // The same letter typed quickly twice ("ss") still means "next s".
    expect(typeaheadIndex(MORE, 0, "ss")).toBe(5);
  });

  it("narrows by a longer prefix, keeping a match it already sits on", () => {
    expect(typeaheadIndex(MORE, -1, "export a")).toBe(2);
    expect(typeaheadIndex(MORE, 1, "ex")).toBe(1);
    expect(typeaheadIndex(MORE, 1, "export as")).toBe(2);
  });

  it("returns -1 when nothing matches", () => {
    expect(typeaheadIndex(MORE, 2, "z")).toBe(-1);
    expect(typeaheadIndex([], -1, "a")).toBe(-1);
    expect(typeaheadIndex(MORE, 0, "")).toBe(-1);
  });
});
