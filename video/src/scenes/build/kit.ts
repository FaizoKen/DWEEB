import { Easing } from "remotion";
import { STOCK_ART } from "../../story/campaign";

/**
 * Small motion kit shared by the templates and build scenes (the two halves of
 * the editor act that meet at the templates → build hold cut).
 */

/**
 * The product's own curves: overlays rise with galleryRise / menuIn / the
 * toast's slide (cubic-bezier(0.16, 1, 0.3, 1)); layout changes use the app's
 * standard cubic-bezier(0.4, 0, 0.2, 1).
 */
export const EASE_RISE = Easing.bezier(0.16, 1, 0.3, 1);
export const EASE_UI = Easing.bezier(0.4, 0, 0.2, 1);

/** 0 → 1 over [start, start + dur), eased; exactly 0 before and exactly 1 after. */
export const ramp = (frame: number, start: number, dur: number, ease: (t: number) => number = EASE_UI): number =>
  frame <= start ? 0 : frame >= start + dur ? 1 : ease((frame - start) / dur);

/** 0 → 1 → 0: rises over `rise` from `start`, holds, falls over `fall` ending at `end`. Exactly 0 outside. */
export const envelope = (frame: number, start: number, end: number, rise = 4, fall = 6): number => {
  if (frame <= start || frame >= end) return 0;
  return Math.min(1, ramp(frame, start, rise), 1 - ramp(frame, end - fall, fall));
};

/** A one-shot bump 0 → 1 → 0 over `dur` frames from `start` (stat-pill ticks). */
export const bump = (frame: number, start: number, dur = 9): number =>
  frame < start || frame >= start + dur ? 0 : (frame - start + 1) / dur;

/** Linear interpolation. */
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * The stock template's art over the gallery's hero slot (story/campaign.ts
 * STOCK_ART) as the preview's `gallerySwap`: `t` = 1 shows the stock art,
 * 0 the campaign's own hero (no swap at all, so the frame is the plain gallery).
 */
export const stockArt = (t: number) => (t > 0.001 ? { ...STOCK_ART, t: Math.min(1, t) } : undefined);
