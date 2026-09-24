import React from "react";
import { COLORS } from "../../theme";
import { withAlpha } from "../../lib/color";

/**
 * The DWEEB mascot with a DIRECTED gaze — the same drawing as
 * components/Mascot.tsx (recreated from public/favicon.svg), but the pupils
 * and the blink are props instead of an idle loop.
 *
 * Why a local copy: the shared Mascot drifts its pupils on a sine and blinks
 * every 80 frames, whatever the scene is doing — on the end card that means a
 * blink landing inside the settled hold (and possibly on the cover still). Here
 * the mascot watches the action instead: the query being typed, the G being
 * pressed, then the result it found. (Handoff: a `gaze`/`blink` prop on the
 * shared Mascot would let this file go.)
 */
export const GazeMascot: React.FC<{
  size: number;
  /** Pupil offset in the drawing's 512-unit space (≈ ±22 stays inside the lenses). */
  look?: { x: number; y: number };
  /** Eye openness: 1 open … 0.1 shut. */
  open?: number;
  glow?: boolean;
}> = ({ size, look = { x: 0, y: 0 }, open = 1, glow = true }) => {
  const eyes =
    look.x !== 0 || look.y !== 0 || open !== 1
      ? `translate(${look.x.toFixed(2)}px, ${look.y.toFixed(2)}px) scaleY(${open.toFixed(3)})`
      : undefined;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      style={{
        display: "block",
        filter: glow
          ? `drop-shadow(0 ${size * 0.066}px ${size * 0.17}px ${withAlpha(COLORS.blurple, 0.4)}) drop-shadow(0 0 ${size * 0.08}px ${withAlpha(COLORS.blurple, 0.27)})`
          : undefined,
      }}
    >
      <rect width="512" height="512" rx="112" fill={COLORS.blurple} />
      <rect width="512" height="256" rx="112" fill="#ffffff" opacity="0.06" />

      <rect x="40" y="210" width="52" height="30" rx="15" fill="#fff" />
      <rect x="420" y="210" width="52" height="30" rx="15" fill="#fff" />
      <rect x="214" y="200" width="84" height="30" rx="15" fill={COLORS.green} />
      <rect x="78" y="182" width="148" height="148" rx="46" fill="#fff" />
      <rect x="286" y="182" width="148" height="148" rx="46" fill="#fff" />

      <g style={eyes ? { transform: eyes, transformOrigin: "center", transformBox: "fill-box" } : undefined}>
        <circle cx={152} cy={256} r={30} fill={COLORS.bg} />
        <circle cx={360} cy={256} r={30} fill={COLORS.bg} />
        <circle cx={162} cy={246} r={9} fill="#fff" opacity={0.9} />
        <circle cx={370} cy={246} r={9} fill="#fff" opacity={0.9} />
      </g>

      <path d="M226 360 h28 v24 a12 12 0 0 1 -12 12 h-4 a12 12 0 0 1 -12 -12 z" fill="#fff" />
      <path d="M258 360 h28 v24 a12 12 0 0 1 -12 12 h-4 a12 12 0 0 1 -12 -12 z" fill="#fff" />
    </svg>
  );
};
