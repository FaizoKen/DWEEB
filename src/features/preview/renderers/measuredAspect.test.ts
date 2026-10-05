import { describe, expect, it } from "vitest";

import { nextAspect } from "./measuredAspect";

describe("nextAspect", () => {
  it("keeps the previous state object when nothing changed — the render-loop guard", () => {
    // The gallery's ref re-measures a cached image on every render; a fresh
    // object each time re-rendered forever and froze the whole page.
    const prev = { src: "https://cdn.example/a.webp", ratio: 1.5 };
    expect(nextAspect(prev, "https://cdn.example/a.webp", 1.5)).toBe(prev);
  });

  it("records a new source or a new shape", () => {
    const prev = { src: "https://cdn.example/a.webp", ratio: 1.5 };
    expect(nextAspect(prev, "https://cdn.example/b.webp", 1.5)).toEqual({
      src: "https://cdn.example/b.webp",
      ratio: 1.5,
    });
    expect(nextAspect(prev, "https://cdn.example/a.webp", 2)).toEqual({
      src: "https://cdn.example/a.webp",
      ratio: 2,
    });
    expect(nextAspect(null, "https://cdn.example/a.webp", 1)).toEqual({
      src: "https://cdn.example/a.webp",
      ratio: 1,
    });
  });
});
