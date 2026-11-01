import { describe, expect, it } from "vitest";
import { placeMenu } from "./menuPlacement";

const viewport = { width: 1280, height: 720 };
/** A trigger in a top bar, near the right edge. */
const topBar = { left: 1000, right: 1090, top: 10, bottom: 42 };

describe("placeMenu", () => {
  it("opens below the trigger, at its natural size, when it fits", () => {
    expect(placeMenu(topBar, { width: 300, height: 400 }, viewport, "end")).toEqual({
      left: 790,
      top: 48,
      maxHeight: null,
    });
  });

  it("scrolls a panel taller than the space below instead of running off the screen", () => {
    const short = { width: 1280, height: 500 };
    const placed = placeMenu(topBar, { width: 300, height: 620 }, short, "end");
    expect(placed.top).toBe(48);
    expect(placed.maxHeight).toBe(444);
    expect(placed.top + placed.maxHeight!).toBe(short.height - 8);
  });

  it("flips above when that side has more room", () => {
    const low = { left: 100, right: 190, top: 600, bottom: 632 };
    expect(placeMenu(low, { width: 200, height: 300 }, viewport, "start")).toEqual({
      left: 100,
      top: 294,
      maxHeight: null,
    });
  });

  it("caps a flipped panel so its top stays on screen", () => {
    const low = { left: 100, right: 190, top: 400, bottom: 432 };
    const placed = placeMenu(
      low,
      { width: 200, height: 600 },
      { width: 800, height: 500 },
      "start",
    );
    expect(placed).toEqual({ left: 100, top: 8, maxHeight: 386 });
  });

  it("clamps horizontally to the viewport", () => {
    const edge = { left: 2, right: 40, top: 10, bottom: 42 };
    expect(
      placeMenu(edge, { width: 300, height: 100 }, { width: 320, height: 640 }, "end").left,
    ).toBe(8);
    expect(
      placeMenu(topBar, { width: 300, height: 100 }, { width: 1100, height: 640 }, "start").left,
    ).toBe(792);
  });
});
