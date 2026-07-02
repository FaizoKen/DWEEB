import React from "react";
import { useCurrentFrame, interpolate } from "remotion";
import { COLORS } from "../theme";

/**
 * The DWEEB mascot — a blurple rounded square wearing white "glasses" with a
 * green bridge (recreated from public/favicon.svg). The pupils drift and blink
 * so it always feels alive.
 */
export const Mascot: React.FC<{
  size?: number;
  glow?: boolean;
  look?: boolean;
}> = ({ size = 360, glow = true, look = true }) => {
  const frame = useCurrentFrame();

  const lookX = look ? Math.sin(frame / 40) * 10 : 0;
  const lookY = look ? Math.cos(frame / 55) * 6 : 0;

  const blinkPhase = (frame % 80) / 80;
  const blink =
    blinkPhase > 0.94 ? interpolate(blinkPhase, [0.94, 0.97, 1], [1, 0.1, 1]) : 1;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      style={{
        filter: glow
          ? `drop-shadow(0 24px 60px ${COLORS.blurple}66) drop-shadow(0 0 30px ${COLORS.blurple}44)`
          : "none",
      }}
    >
      <rect width="512" height="512" rx="112" fill={COLORS.blurple} />
      <rect width="512" height="256" rx="112" fill="#ffffff" opacity="0.06" />

      <rect x="40" y="210" width="52" height="30" rx="15" fill="#fff" />
      <rect x="420" y="210" width="52" height="30" rx="15" fill="#fff" />
      <rect x="214" y="200" width="84" height="30" rx="15" fill={COLORS.green} />
      <rect x="78" y="182" width="148" height="148" rx="46" fill="#fff" />
      <rect x="286" y="182" width="148" height="148" rx="46" fill="#fff" />

      {/* eyes */}
      <g
        style={{
          transform: `translate(${lookX}px, ${lookY}px) scaleY(${blink})`,
          transformOrigin: "center",
          transformBox: "fill-box",
        }}
      >
        <circle cx={152} cy={256} r={30} fill={COLORS.bg} />
        <circle cx={360} cy={256} r={30} fill={COLORS.bg} />
        <circle cx={162} cy={246} r={9} fill="#fff" opacity={0.9} />
        <circle cx={370} cy={246} r={9} fill="#fff" opacity={0.9} />
      </g>

      {/* teeth / feet */}
      <path d="M226 360 h28 v24 a12 12 0 0 1 -12 12 h-4 a12 12 0 0 1 -12 -12 z" fill="#fff" />
      <path d="M258 360 h28 v24 a12 12 0 0 1 -12 12 h-4 a12 12 0 0 1 -12 -12 z" fill="#fff" />
    </svg>
  );
};
