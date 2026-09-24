import React from "react";
import { spring, useCurrentFrame, useVideoConfig } from "remotion";
import { settle } from "../../components/Bits";
import { INTER } from "../../fonts";
import { withAlpha } from "../../lib/color";
import { COLORS } from "../../theme";
import { FPS } from "../../timeline";
import { HEADLINE_FOOT, HEADLINE_LH, type CtaLayout, lineHeightOf } from "./layout";

/**
 * The end card's headline: every word SLAMS up out of a mask on its baseline —
 * a stiff spring that lands in 4 frames, overshoots ~7% and settles — keyed by
 * the scene to the word the narrator speaks.
 *
 * The mask is the fix for v5's boxed glows. v5 wrapped each line in
 * `overflow: hidden`, which also cut every text-shadow into a hard rectangle
 * (baked into the posters). Here the clip is a `clip-path` that trims ONLY the
 * bottom edge (the baseline the word rises from) with generous negative insets
 * elsewhere, and it is dropped the moment the word first reaches its baseline.
 * After that the word can overshoot and settle freely: nothing clips it, so
 * its shadow and the green glow stay soft on every settled frame.
 */

const SLAM = { damping: 14, mass: 0.45, stiffness: 260 } as const;

/** Frames from a word's start until it first reaches its baseline (4 at 30 fps). */
export const SLAM_LANDS_AFTER = (() => {
  for (let f = 1; f < 60; f++) {
    if (spring({ frame: f, fps: FPS, config: SLAM }) >= 1) return f;
  }
  throw new Error("Headline: the slam spring never reaches its baseline — retune SLAM.");
})();

/** Frames from a word's start until it is exactly at rest (settle() snaps it). */
export const SLAM_SETTLES_AFTER = (() => {
  for (let f = SLAM_LANDS_AFTER; f < 90; f++) {
    let rest = true;
    for (let g = f; g < f + 30 && rest; g++) rest = settle(spring({ frame: g, fps: FPS, config: SLAM })) === 1;
    if (rest) return f;
  }
  throw new Error("Headline: the slam spring never settles — retune SLAM.");
})();

const SlamWord: React.FC<{
  text: string;
  /** Scene-local frame the word starts rising. */
  start: number;
  size: number;
  accent: boolean;
}> = ({ text, start, size, accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // Before its start the word still takes its place (hidden), so a line never
  // reflows as later words arrive.
  const waiting = frame < start;
  const p = waiting ? 0 : settle(spring({ frame: frame - start, fps, config: SLAM }));
  const landed = frame - start >= SLAM_LANDS_AFTER;
  const lift = 1 - p;
  return (
    <span
      style={{
        display: "inline-block",
        paddingBottom: `${HEADLINE_FOOT}em`,
        fontSize: size,
        // Bottom-only mask while rising: the glyphs come up out of the
        // baseline, but nothing above or beside them is ever clipped.
        clipPath: landed ? undefined : "inset(-1em -0.6em 0 -0.6em)",
        visibility: waiting ? "hidden" : undefined,
      }}
    >
      <span
        style={{
          display: "inline-block",
          ...wordFace(size, accent),
          fontSize: "1em",
          transform:
            p === 1 ? undefined : `translateY(${(lift * 0.95).toFixed(4)}em) skewY(${(lift * 5).toFixed(3)}deg)`,
          transformOrigin: "left bottom",
        }}
      >
        {text}
      </span>
    </span>
  );
};

const wordFace = (size: number, accent: boolean): React.CSSProperties => ({
  fontFamily: INTER,
  fontSize: size,
  lineHeight: HEADLINE_LH,
  fontWeight: 900,
  letterSpacing: accent ? "-0.065em" : "-0.055em",
  textTransform: "uppercase",
  whiteSpace: "nowrap",
  color: accent ? COLORS.green : COLORS.text,
  textShadow: accent
    ? `0 0 ${size * 0.34}px ${withAlpha(COLORS.green, 0.2)}, 0 ${size * 0.07}px ${size * 0.3}px rgba(0,0,0,.38)`
    : `0 ${size * 0.1}px ${size * 0.42}px rgba(0,0,0,.5)`,
});

/**
 * The headline block. `starts[i]` is the frame word i (in reading order across
 * all lines) starts rising; a line's words sit on one baseline, a word-space
 * apart.
 */
export const Headline: React.FC<{ layout: CtaLayout; starts: number[] }> = ({ layout, starts }) => {
  let w = 0;
  return (
    <div style={{ position: "absolute", left: layout.headline.x, top: layout.headline.y }}>
      {layout.headline.lines.map((line, li) => (
        <div
          key={li}
          style={{
            display: "flex",
            gap: line.size * 0.24,
            height: lineHeightOf(line.size),
            alignItems: "flex-start",
          }}
        >
          {line.words.map((word) => {
            const i = w++;
            return <SlamWord key={word} text={word} start={starts[i]} size={line.size} accent={!!line.accent} />;
          })}
        </div>
      ))}
    </div>
  );
};

/** Number of words in the layout's headline (the scene keys one start per word). */
export const headlineWordCount = (layout: CtaLayout) =>
  layout.headline.lines.reduce((n, line) => n + line.words.length, 0);
