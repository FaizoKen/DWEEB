import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LEFT_MAX_RESERVE, measureNeededWidth, toolsFoldSteps } from "./measureBarFit";

/**
 * The fit check only reads widths and computed spacing, so plain objects stand in
 * for the three elements (Vitest runs in Node, without a DOM). The bar has 12px
 * padding on each side and a 12px gap between its two clusters.
 */
function fakeElement(width: number) {
  return {
    style: { transition: "all 10us", minWidth: "0px" },
    getBoundingClientRect: () => ({ width }),
  } as unknown as HTMLElement;
}

const PADDING_AND_GAP = 12 + 12 + 12;

beforeEach(() => {
  (globalThis as { getComputedStyle?: unknown }).getComputedStyle = () => ({
    paddingLeft: "12px",
    paddingRight: "12px",
    columnGap: "12px",
  });
});

afterEach(() => {
  delete (globalThis as { getComputedStyle?: unknown }).getComputedStyle;
});

describe("measureNeededWidth", () => {
  it("reserves the left cluster's natural width while it's under the cap", () => {
    const needed = measureNeededWidth(fakeElement(0), fakeElement(90), fakeElement(400));
    expect(needed).toBe(400 + 90 + PADDING_AND_GAP);
  });

  it("caps the reserve at the Activity bar's default when no cap is passed", () => {
    const needed = measureNeededWidth(fakeElement(0), fakeElement(260), fakeElement(400));
    expect(LEFT_MAX_RESERVE).toBe(150);
    expect(needed).toBe(400 + LEFT_MAX_RESERVE + PADDING_AND_GAP);
  });

  it("honours a caller's larger cap (the web builder's destination reserve)", () => {
    const needed = measureNeededWidth(fakeElement(0), fakeElement(260), fakeElement(400), 210);
    expect(needed).toBe(400 + 210 + PADDING_AND_GAP);
  });

  it("puts back the inline styles it overrides while measuring", () => {
    const bar = fakeElement(0);
    const left = fakeElement(120);
    const right = fakeElement(300);
    measureNeededWidth(bar, left, right);
    for (const el of [bar, left, right]) expect(el.style.transition).toBe("all 10us");
    expect(left.style.minWidth).toBe("0px");
  });
});

describe("toolsFoldSteps", () => {
  /** What a rung keeps inline, in measured px: an icon, and Tools either way. */
  const width = ({ inline, labelled }: { inline: number; labelled: boolean }) =>
    inline * 36 + (labelled ? 92 : 30);

  it("gives up the icons first, then the label, then brings one icon back", () => {
    expect(toolsFoldSteps(3)).toEqual([
      { inline: 3, labelled: true },
      { inline: 2, labelled: true },
      { inline: 1, labelled: true },
      { inline: 0, labelled: true },
      { inline: 1, labelled: false },
      { inline: 0, labelled: false },
    ]);
  });

  it("only ever narrows the bar, so the fit check can stop at the first rung that fits", () => {
    for (const inlineMax of [0, 1, 2, 3]) {
      const widths = toolsFoldSteps(inlineMax).map(width);
      expect(widths).toEqual([...widths].sort((a, b) => b - a));
      expect(new Set(widths).size).toBe(widths.length);
    }
  });

  it("starts from the full row and ends with neither icons nor label", () => {
    for (const inlineMax of [0, 1, 2, 3]) {
      const steps = toolsFoldSteps(inlineMax);
      expect(steps[0]).toEqual({ inline: inlineMax, labelled: true });
      expect(steps.at(-1)).toEqual({ inline: 0, labelled: false });
    }
  });
});
