/**
 * End-card geometry, per aspect, in WORLD px (the 1920×1080 stage both masters
 * film). One table drives both the render and the pointer's aim at the Google
 * "G", so the press can never drift off its button when the layout is tuned.
 *
 * Landscape films the whole world at rest (s = 1, canvas px = world px).
 * Vertical lays out on the portrait stage (world x 690–1230, y 60–1020) with
 * the locked portrait camera (s = 2, 1 world px = 2 canvas px); canvas y 0–220
 * stays empty for the web player's sound pill and close button, and the URL is
 * the largest line after the headline (it is the film's only direct address).
 */

export type HeadlineLineSpec = {
  /** Words of the line, each slammed in on its own spoken word. */
  words: string[];
  /** Font size (world px). */
  size: number;
  accent?: boolean;
};

export type BarGeo = {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Width of the Google "G" button at the bar's far end. */
  gW: number;
  /** Query font size. */
  font: number;
  /** Magnifier size and the bar's left padding. */
  icon: number;
  padL: number;
  /** The G mark's size. */
  gIcon: number;
};

export type ResultGeo = {
  x: number;
  y: number;
  w: number;
  pad: number;
  /** Favicon tile edge. */
  fav: number;
  /** Title and URL font sizes. */
  title: number;
  url: number;
  /** Gap between the title row and the URL row. */
  gap: number;
  radius: number;
};

export type CtaLayout = {
  /** Camera at rest (after the recoil). */
  cam: { x: number; y: number; s: number };
  /** Where the camera settles after the slow push (end of the scene's motion). */
  push: { k: number; pivot: { x: number; y: number } };
  wordmark: { x: number; y: number; size: number };
  headline: { x: number; y: number; lines: HeadlineLineSpec[] };
  /** Gradient rule under the last line. */
  underline: { w: number; h: number; gap: number };
  bar: BarGeo;
  /** The mascot peeks over the bar: horizontal centre, resting top, tile edge. */
  mascot: { cx: number; top: number; size: number; tilt: number };
  result: ResultGeo;
};

/** Line box height of a headline line (line-height .89 + the mask's .05em foot). */
export const HEADLINE_LH = 0.89;
export const HEADLINE_FOOT = 0.05;
export const lineHeightOf = (size: number) => size * (HEADLINE_LH + HEADLINE_FOOT);

export const LAYOUT_L: CtaLayout = {
  cam: { x: 960, y: 540, s: 1 },
  // A 2% push toward the action column; the headline stays whole in frame.
  push: { k: 1.02, pivot: { x: 1420, y: 600 } },
  wordmark: { x: 160, y: 124, size: 48 },
  headline: {
    x: 160,
    y: 336,
    lines: [
      { words: ["Build", "better"], size: 104 },
      { words: ["Discord"], size: 132 },
      { words: ["messages."], size: 150, accent: true },
    ],
  },
  underline: { w: 400, h: 9, gap: 22 },
  bar: { x: 1080, y: 540, w: 690, h: 106, gW: 108, font: 27, icon: 28, padL: 30, gIcon: 46 },
  mascot: { cx: 1566, top: 298, size: 296, tilt: -5 },
  result: { x: 1080, y: 676, w: 690, pad: 28, fav: 46, title: 28, url: 40, gap: 12, radius: 24 },
};

export const LAYOUT_V: CtaLayout = {
  cam: { x: 960, y: 540, s: 2 },
  // Pivot on the wordmark's corner so the push never lifts it into the
  // player chrome band (canvas y < 220).
  push: { k: 1.02, pivot: { x: 716, y: 196 } },
  wordmark: { x: 716, y: 196, size: 30 },
  headline: {
    x: 716,
    y: 262,
    lines: [
      { words: ["Build"], size: 78 },
      { words: ["better"], size: 78 },
      { words: ["Discord"], size: 78 },
      { words: ["messages."], size: 86, accent: true },
    ],
  },
  underline: { w: 196, h: 5, gap: 14 },
  bar: { x: 716, y: 712, w: 446, h: 66, gW: 66, font: 22, icon: 22, padL: 20, gIcon: 31 },
  mascot: { cx: 1046, top: 590, size: 150, tilt: -5 },
  result: { x: 716, y: 798, w: 446, pad: 18, fav: 30, title: 17, url: 23.5, gap: 9, radius: 16 },
};

/** Centre of the Google "G" button (world px): where the press lands. */
export const gCenter = (bar: BarGeo) => ({ x: bar.x + bar.w - bar.gW / 2, y: bar.y + bar.h / 2 });

/** Bottom of the headline block (world y), where the underline hangs. */
export const headlineBottom = (l: CtaLayout) =>
  l.headline.y + l.headline.lines.reduce((sum, line) => sum + lineHeightOf(line.size), 0);

/**
 * The camera centre that keeps world point `pivot` fixed on the canvas while
 * the zoom goes from `rest.s` to `rest.s × k` — the recoil and the push both
 * scale about a chosen point instead of the frame centre.
 */
export const zoomAbout = (rest: { x: number; y: number; s: number }, pivot: { x: number; y: number }, k: number) => ({
  x: pivot.x + (rest.x - pivot.x) / k,
  y: pivot.y + (rest.y - pivot.y) / k,
  s: rest.s * k,
});
