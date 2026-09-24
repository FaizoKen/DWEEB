import React from "react";
import { Easing, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS } from "../../theme";
import { INTER } from "../../fonts";
import { withAlpha } from "../../lib/color";
import { Mascot } from "../../components/Mascot";
import { settle } from "../../components/Bits";

/**
 * The DWEEB brand lockup for "Meet DWEEB" — a film device, not product UI. It
 * follows the brand's own lockup (public/og-image.png): the mascot tile, the
 * wide-tracked DWEEB wordmark, the short green bar, the product line.
 * `stacked` is that lockup as-is (the landscape builder column has the room);
 * `row` sets the mascot beside the text for the portrait top band.
 *
 * It never shares the screen with the action bar it could crowd: the reveal
 * lifts it away before the builder assembles, so cut A is the plain editor.
 *
 * Choreography (scene-local frames from `enter`, which the reveal places 8
 * frames before the spoken name): the mascot springs in with a small overshoot
 * while the five letters ripple up out of it 1.5 frames apart, so the whole
 * word reads as it is spoken; the green bar draws on the name itself (the
 * brand pop), then the product line settles. `exit` lifts and fades it all.
 */
export type LockupSize = {
  layout: "stacked" | "row";
  /** Mascot tile edge. */
  mascot: number;
  /** Wordmark font size. */
  word: number;
  /** Product-line font size. */
  line: number;
  /** Gap between the mascot and the text. */
  gap: number;
};

const LETTERS = "DWEEB".split("");
/** Frames between letters: a quick ripple, whole by the spoken name. */
const LETTER_STAGGER = 1.5;
/** The green bar draws from here (enter + 8 = the name, where the pop sounds). */
const BAR_DELAY = 8;
const EXIT_EASE = Easing.bezier(0.4, 0, 0.7, 1);

export const BrandLockup: React.FC<{
  size: LockupSize;
  /** Scene-local frame the lockup starts entering. */
  enter: number;
  /** Scene-local frame the exit starts; `exitFrames` long. */
  exit: number;
  exitFrames?: number;
}> = ({ size, enter, exit, exitFrames = 10 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < enter) return null;
  const out = EXIT_EASE(Math.max(0, Math.min(1, (frame - exit) / exitFrames)));
  if (out >= 1) return null;

  const spr = (at: number, config: { damping: number; mass: number; stiffness: number }) =>
    settle(spring({ frame: frame - at, fps, config }));
  const mascot = spr(enter, { damping: 11, mass: 0.6, stiffness: 170 });
  const bar = spr(enter + BAR_DELAY, { damping: 22, mass: 0.5, stiffness: 180 });
  const line = spr(enter + 10, { damping: 20, mass: 0.6, stiffness: 150 });
  const stacked = size.layout === "stacked";

  const wordmark = (
    <div style={{ display: "flex" }}>
      {LETTERS.map((ch, i) => {
        const p = spr(enter + i * LETTER_STAGGER, { damping: 16, mass: 0.45, stiffness: 260 });
        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              fontSize: size.word,
              fontWeight: 900,
              lineHeight: 1,
              // The og-image's wide tracking; the last letter keeps no trailing space.
              marginRight: i < LETTERS.length - 1 ? size.word * 0.06 : 0,
              color: COLORS.text,
              textShadow: `0 ${size.word * 0.08}px ${size.word * 0.4}px rgba(0,0,0,0.5)`,
              opacity: p < 1 ? Math.min(1, p * 1.5) : undefined,
              transform: p < 1 ? `translateY(${((1 - p) * size.word * 0.38).toFixed(2)}px) scale(${(0.72 + 0.28 * p).toFixed(4)})` : undefined,
            }}
          >
            {ch}
          </span>
        );
      })}
    </div>
  );
  const barW = size.word * (stacked ? 0.95 : 0.8);
  const accent = (
    <div
      style={{
        width: barW,
        height: Math.max(2, size.word * 0.07),
        display: "flex",
        justifyContent: stacked ? "center" : "flex-start",
      }}
    >
      {bar > 0.001 && (
        <div
          style={{
            width: barW * bar,
            height: "100%",
            borderRadius: 999,
            background: COLORS.green,
            boxShadow: `0 0 ${size.word * 0.3}px ${withAlpha(COLORS.green, 0.55)}`,
          }}
        />
      )}
    </div>
  );
  const product = (
    <span
      style={{
        fontSize: size.line,
        fontWeight: 600,
        lineHeight: 1.2,
        letterSpacing: "0.005em",
        color: COLORS.textMuted,
        whiteSpace: "nowrap",
        opacity: line < 1 ? line : undefined,
        transform: line < 1 ? `translateY(${((1 - line) * size.line * 0.6).toFixed(2)}px)` : undefined,
        textShadow: `0 2px ${size.line}px ${withAlpha("#000000", 0.45)}`,
      }}
    >
      Visual Discord message builder
    </span>
  );
  const tile = (
    <div
      style={{
        width: size.mascot,
        height: size.mascot,
        flexShrink: 0,
        opacity: mascot < 1 ? Math.min(1, mascot * 2) : undefined,
        transform: mascot < 1 ? `scale(${(0.45 + 0.55 * mascot).toFixed(4)}) rotate(${((1 - mascot) * -10).toFixed(2)}deg)` : undefined,
      }}
    >
      <Mascot size={size.mascot} glow look={false} />
    </div>
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: stacked ? "column" : "row",
        alignItems: "center",
        gap: size.gap,
        opacity: out > 0 ? 1 - out : undefined,
        transform: out > 0 ? `translateY(${(-out * size.mascot * 0.14).toFixed(2)}px) scale(${1 - 0.03 * out})` : undefined,
        fontFamily: INTER,
      }}
    >
      {tile}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: stacked ? "center" : "flex-start",
          gap: size.line * (stacked ? 0.7 : 0.4),
        }}
      >
        {wordmark}
        {accent}
        {product}
      </div>
    </div>
  );
};
