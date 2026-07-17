import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";
import { COLORS } from "../theme";

/** A restrained motion-design stage: deep ink, slow aurora light, a floor grid,
 * and sparse dust. The center stays quiet enough for product UI while the edges
 * carry enough color and depth to keep wide shots from feeling empty. */
export const Background: React.FC<{ glow?: "blurple" | "green" | "dual" }> = ({
  glow = "dual",
}) => {
  const frame = useCurrentFrame();
  const driftX = Math.sin(frame / 105) * 42;
  const driftY = Math.cos(frame / 132) * 30;
  const greenAlpha = glow === "blurple" ? 0.08 : 0.18;
  const blurpleAlpha = glow === "green" ? 0.12 : 0.26;

  return (
    <AbsoluteFill
      style={{ background: "linear-gradient(145deg, #08090d 0%, #0d1018 54%, #080a0f 100%)" }}
    >
      <div
        style={{
          position: "absolute",
          width: 1040,
          height: 820,
          left: -240 + driftX,
          top: -280 + driftY,
          borderRadius: "50%",
          background: COLORS.blurple,
          opacity: blurpleAlpha,
          filter: "blur(150px)",
          transform: `scale(${1 + Math.sin(frame / 80) * 0.05})`,
        }}
      />
      <div
        style={{
          position: "absolute",
          width: 900,
          height: 720,
          right: -260 - driftX * 0.7,
          bottom: -280 - driftY * 0.6,
          borderRadius: "50%",
          background: COLORS.green,
          opacity: greenAlpha,
          filter: "blur(170px)",
          transform: `scale(${1 + Math.cos(frame / 94) * 0.06})`,
        }}
      />
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(116deg, transparent 12%, rgba(125,137,255,.055) 37%, transparent 57%), linear-gradient(72deg, transparent 44%, rgba(87,242,135,.035) 59%, transparent 75%)",
          transform: `translateX(${Math.sin(frame / 140) * 28}px)`,
        }}
      />

      {/* perspective floor: depth without the graph-paper look */}
      <AbsoluteFill
        style={{
          top: "49%",
          height: "72%",
          backgroundImage: `linear-gradient(${COLORS.borderStrong}30 1px, transparent 1px), linear-gradient(90deg, ${COLORS.borderStrong}30 1px, transparent 1px)`,
          backgroundSize: "76px 76px",
          transform: "perspective(620px) rotateX(62deg) scale(1.25)",
          transformOrigin: "center top",
          maskImage:
            "linear-gradient(to bottom, transparent, rgba(0,0,0,.75) 24%, transparent 88%)",
          WebkitMaskImage:
            "linear-gradient(to bottom, transparent, rgba(0,0,0,.75) 24%, transparent 88%)",
          opacity: 0.42,
        }}
      />
      <Particles />
      {/* fine texture prevents large gradients from banding in H.264 */}
      <AbsoluteFill
        style={{
          backgroundImage:
            "repeating-radial-gradient(circle at 17% 23%, rgba(255,255,255,.12) 0 .45px, transparent .6px 3px)",
          backgroundSize: "7px 7px",
          opacity: 0.025,
          mixBlendMode: "screen",
        }}
      />
      <AbsoluteFill
        style={{
          background: "radial-gradient(90% 82% at 50% 45%, transparent 42%, rgba(0,0,0,.68) 100%)",
        }}
      />
    </AbsoluteFill>
  );
};

const PARTICLES = new Array(20).fill(0).map((_, i) => ({
  x: (i * 97) % 100,
  y: (i * 53) % 100,
  size: 1 + ((i * 7) % 3),
  speed: 0.25 + (i % 5) * 0.1,
  green: i % 4 === 0,
}));

const Particles: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill>
      {PARTICLES.map((p, i) => {
        const y = (p.y - frame * p.speed * 0.12 + 200) % 100;
        const twinkle = interpolate(Math.sin(frame / 18 + i), [-1, 1], [0.08, 0.42]);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: `${p.x}%`,
              top: `${y}%`,
              width: p.size,
              height: p.size,
              borderRadius: "50%",
              background: p.green ? COLORS.green : "#aeb6ff",
              opacity: twinkle,
              filter: "blur(0.3px)",
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};
