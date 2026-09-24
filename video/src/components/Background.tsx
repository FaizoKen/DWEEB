import React from "react";
import { AbsoluteFill, interpolate } from "remotion";
import { COLORS, STAGE_COLOR } from "../theme";
import { useFilmFrame } from "./Camera";

/**
 * A soft glow drawn as a radial gradient: the exact look of v5's ellipse under
 * `filter: blur(σ)`, without the blur. The stops were fitted numerically to the
 * Gaussian-blurred ellipse (`profile` = alpha at each fraction of the gradient
 * radii; max error 4% alpha, i.e. ≤ 3 colour levels at the glows' opacity), and
 * an A/B still diff against the blurred original stays within 2–6 levels with
 * no new banding — at 7× contrast the blur actually showed faceted Skia
 * downsampling contours that the gradient does not. A 150–170 px blur on a
 * frame-sized layer was the single most expensive thing on every frame.
 */
type Glow = {
  /** Gradient radii (px): where the glow reaches zero. */
  rx: number;
  ry: number;
  /** [fraction of the radii, alpha] stops; linear in between. */
  profile: ReadonlyArray<readonly [number, number]>;
};

// ellipse 1040×820, blur(150px)
const BLURPLE_GLOW: Glow = {
  rx: 1060,
  ry: 867.5,
  profile: [
    [0, 0.9893], [0.2, 0.947], [0.3, 0.8463], [0.4, 0.6466], [0.45, 0.5152], [0.5, 0.3855],
    [0.55, 0.2624], [0.6, 0.1659], [0.65, 0.0934], [0.7, 0.0486], [0.75, 0.0221], [0.8, 0.0092],
    [0.85, 0.0033], [0.9, 0.001], [0.95, 0.0002], [1, 0],
  ],
};
// ellipse 900×720, blur(170px)
const GREEN_GLOW: Glow = {
  rx: 1062,
  ry: 904,
  profile: [
    [0, 0.9342], [0.2, 0.8228], [0.3, 0.6598], [0.4, 0.4416], [0.45, 0.3296], [0.5, 0.2299],
    [0.55, 0.1516], [0.6, 0.0912], [0.65, 0.0518], [0.7, 0.0264], [0.75, 0.0127], [0.8, 0.0054],
    [0.85, 0.0021], [0.9, 0.0006], [0.95, 0.0001], [1, 0],
  ],
};

const rgbOf = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(",");
const glowImage = (glow: Glow, hex: string) =>
  `radial-gradient(${glow.rx}px ${glow.ry}px at 50% 50%, ${glow.profile
    .map(([at, alpha]) => `rgba(${rgbOf(hex)},${alpha}) ${Math.round(at * 100)}%`)
    .join(", ")})`;
const BLURPLE_IMAGE = glowImage(BLURPLE_GLOW, COLORS.blurple);
const GREEN_IMAGE = glowImage(GREEN_GLOW, COLORS.green);

/** A restrained motion-design stage: deep ink, slow aurora light, a floor grid,
 * and sparse dust. The center stays quiet enough for product UI while the edges
 * carry enough color and depth to keep wide shots from feeling empty.
 *
 * Every drift runs on FILM time (useFilmFrame), so the stage is continuous
 * across cuts: two scenes on either side of a hold cut render the identical
 * background. Scenes joined by a hold must also pass the same `glow`. */
export const Background: React.FC<{ glow?: "blurple" | "green" | "dual" }> = ({
  glow = "dual",
}) => {
  const frame = useFilmFrame();
  const driftX = Math.sin(frame / 105) * 42;
  const driftY = Math.cos(frame / 132) * 30;
  const greenAlpha = glow === "blurple" ? 0.08 : 0.18;
  const blurpleAlpha = glow === "green" ? 0.12 : 0.26;

  return (
    <AbsoluteFill
      style={{ background: `linear-gradient(145deg, ${STAGE_COLOR} 0%, #0d1018 54%, #080a0f 100%)` }}
    >
      {/* blurple glow, top-left (centred where v5's ellipse was: 280, 130) */}
      <div
        style={{
          position: "absolute",
          left: 280 + driftX - BLURPLE_GLOW.rx,
          top: 130 + driftY - BLURPLE_GLOW.ry,
          width: BLURPLE_GLOW.rx * 2,
          height: BLURPLE_GLOW.ry * 2,
          backgroundImage: BLURPLE_IMAGE,
          opacity: blurpleAlpha,
          transform: `scale(${1 + Math.sin(frame / 80) * 0.05})`,
        }}
      />
      {/* green glow, bottom-right (centre 190 / 80 in from the far corner) */}
      <div
        style={{
          position: "absolute",
          right: 190 - driftX * 0.7 - GREEN_GLOW.rx,
          bottom: 80 - driftY * 0.6 - GREEN_GLOW.ry,
          width: GREEN_GLOW.rx * 2,
          height: GREEN_GLOW.ry * 2,
          backgroundImage: GREEN_IMAGE,
          opacity: greenAlpha,
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
      <Particles frame={frame} />
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

const Particles: React.FC<{ frame: number }> = ({ frame }) => (
  <AbsoluteFill>
    {PARTICLES.map((p, i) => {
      const y = (((p.y - frame * p.speed * 0.12) % 100) + 100) % 100;
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
