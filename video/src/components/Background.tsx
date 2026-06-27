import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";
import { COLORS } from "../theme";

/**
 * Cinematic ambient backdrop: a slowly drifting blurple/green radial glow over a
 * deep near-black canvas, plus a faint perspective grid and floating particles.
 * Shared by every scene so the film feels like one continuous space.
 */
export const Background: React.FC<{ glow?: "blurple" | "green" | "dual" }> = ({
  glow = "dual",
}) => {
  const frame = useCurrentFrame();
  const drift = Math.sin(frame / 90) * 6;
  const drift2 = Math.cos(frame / 110) * 6;

  const blurpleGlow = `radial-gradient(60% 60% at ${30 + drift}% ${35 + drift2}%, ${COLORS.blurple}33 0%, transparent 60%)`;
  const greenGlow = `radial-gradient(50% 50% at ${72 - drift}% ${68 - drift2}%, ${COLORS.green}1f 0%, transparent 60%)`;

  const layers =
    glow === "blurple"
      ? blurpleGlow
      : glow === "green"
        ? greenGlow
        : `${blurpleGlow}, ${greenGlow}`;

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.bg }}>
      <AbsoluteFill style={{ background: layers }} />
      {/* faint grid */}
      <AbsoluteFill
        style={{
          backgroundImage: `linear-gradient(${COLORS.border}55 1px, transparent 1px), linear-gradient(90deg, ${COLORS.border}55 1px, transparent 1px)`,
          backgroundSize: "64px 64px",
          maskImage:
            "radial-gradient(70% 70% at 50% 45%, black 30%, transparent 80%)",
          WebkitMaskImage:
            "radial-gradient(70% 70% at 50% 45%, black 30%, transparent 80%)",
          opacity: 0.5,
        }}
      />
      <Particles />
      {/* vignette */}
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(120% 120% at 50% 50%, transparent 55%, rgba(0,0,0,0.55) 100%)",
        }}
      />
    </AbsoluteFill>
  );
};

const PARTICLES = new Array(26).fill(0).map((_, i) => ({
  x: (i * 97) % 100,
  y: (i * 53) % 100,
  size: 1.5 + ((i * 7) % 4),
  speed: 0.3 + ((i % 5) * 0.12),
  green: i % 4 === 0,
}));

const Particles: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill>
      {PARTICLES.map((p, i) => {
        const y = (p.y - frame * p.speed * 0.12 + 200) % 100;
        const twinkle = interpolate(
          Math.sin(frame / 18 + i),
          [-1, 1],
          [0.15, 0.6],
        );
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
