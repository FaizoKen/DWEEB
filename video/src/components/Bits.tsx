/* ── Motion helpers ──────────────────────────────────────────────────────── */

/**
 * Snap a settled spring to exactly 1. A spring only approaches 1, and a value
 * like 0.99996 still emits a non-identity transform/opacity — which Chrome
 * rasterizes differently, so an element that "finished" animating on one side
 * of a hold cut would differ by anti-aliasing from its twin on the other side.
 */
export const settle = (v: number): number => (Math.abs(1 - v) < 1e-3 ? 1 : v);

/* ── Typing ──────────────────────────────────────────────────────────────── */

/**
 * How many characters a typist starting at `start` (frame) has typed by
 * `frame`, at `cps` characters per second. Not clamped to any text length —
 * use it to drive anything that must track the typing exactly (a composer, a
 * tree label, key-tick SFX, a mirrored preview).
 */
export const typedChars = (frame: number, start: number, cps: number, fps: number): number =>
  Math.max(0, Math.floor(((frame - start) / fps) * cps));
