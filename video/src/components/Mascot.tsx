import React from "react";
import { useCurrentFrame, interpolate } from "remotion";
import { COLORS } from "../theme";

type Expression = "normal" | "dead" | "cool";

/**
 * The DWEEB mascot — a blurple rounded square wearing white "glasses" with a
 * green bridge (recreated from public/favicon.svg). Supports a few expressions
 * for comedic beats: living pupils (normal), x_x eyes (dead), and drop-down
 * "deal-with-it" shades (cool).
 */
export const Mascot: React.FC<{
  size?: number;
  glow?: boolean;
  look?: boolean;
  expression?: Expression;
  coolDrop?: number; // 0..1 — how far the shades have dropped down
}> = ({ size = 360, glow = true, look = true, expression = "normal", coolDrop = 1 }) => {
  const frame = useCurrentFrame();

  const lookX = look && expression === "normal" ? Math.sin(frame / 40) * 10 : 0;
  const lookY = look && expression === "normal" ? Math.cos(frame / 55) * 6 : 0;

  const blinkPhase = (frame % 80) / 80;
  const blink =
    expression === "normal" && blinkPhase > 0.94
      ? interpolate(blinkPhase, [0.94, 0.97, 1], [1, 0.1, 1])
      : 1;

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
      {expression === "dead" ? (
        <g stroke={COLORS.bg} strokeWidth={14} strokeLinecap="round">
          <line x1={130} y1={234} x2={174} y2={278} />
          <line x1={174} y1={234} x2={130} y2={278} />
          <line x1={338} y1={234} x2={382} y2={278} />
          <line x1={382} y1={234} x2={338} y2={278} />
        </g>
      ) : (
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
      )}

      {/* sweat drop for the dead/panic look */}
      {expression === "dead" && (
        <path
          d="M412 150 q18 30 0 46 a23 23 0 0 1 -23 -23 q11 -14 23 -23 z"
          fill="#4ea3ff"
          opacity={0.9}
        />
      )}

      {/* teeth / feet */}
      <path d="M226 360 h28 v24 a12 12 0 0 1 -12 12 h-4 a12 12 0 0 1 -12 -12 z" fill="#fff" />
      <path d="M258 360 h28 v24 a12 12 0 0 1 -12 12 h-4 a12 12 0 0 1 -12 -12 z" fill="#fff" />

      {/* deal-with-it shades, drop in from above */}
      {expression === "cool" && (
        <g transform={`translate(0, ${interpolate(coolDrop, [0, 1], [-120, 0])})`}>
          <rect x={64} y={206} width="384" height="14" rx="7" fill="#0a0a0a" />
          <rect x={84} y={210} width="146" height="92" rx="22" fill="#0a0a0a" />
          <rect x={282} y={210} width="146" height="92" rx="22" fill="#0a0a0a" />
          <rect x={226} y={224} width="60" height="12" rx="6" fill="#0a0a0a" />
          <rect x={98} y={222} width="48" height="14" rx="7" fill="#ffffff" opacity={0.55} />
          <rect x={296} y={222} width="48" height="14" rx="7" fill="#ffffff" opacity={0.55} />
        </g>
      )}
    </svg>
  );
};
