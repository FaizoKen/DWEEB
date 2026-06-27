import React from "react";
import {
  AbsoluteFill,
  Audio,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
  Easing,
} from "remotion";
import { Background } from "../components/Background";
import { Camera, Shot } from "../components/Camera";
import { Mascot } from "../components/Mascot";
import { Wordmark } from "../components/Wordmark";
import { Caption } from "../components/Caption";
import { COLORS } from "../theme";
import { INTER } from "../fonts";
import { POP } from "../timeline";

// World anchors for the lockup.
const MASCOT = { x: 960, y: 372 };
const WORD = { x: 960, y: 600 };
const TAG = { x: 960, y: 768 };

/**
 * Cold open: the camera is pushed in tight on the mascot as it lands, then pulls
 * back to reveal the full DWEEB lockup, then creeps slowly down to the tagline —
 * one continuous breath that says "here's who we are."
 */
export const SceneOpening: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const mascot = spring({ frame: frame - 2, fps, config: { damping: 12, mass: 0.8 } });
  const line = spring({ frame: frame - 64, fps, config: { damping: 18, mass: 0.7 } });

  const shots: Shot[] = [
    { f: 0, x: MASCOT.x, y: MASCOT.y, s: 1.22 },
    { f: 28, x: 960, y: 520, s: 1.0, ease: Easing.bezier(0.2, 0, 0.1, 1) },
    { f: 80, x: 960, y: 540, s: 1.03 },
    { f: 128, x: 960, y: 548, s: 1.05 },
  ];

  return (
    <AbsoluteFill>
      <Background glow="dual" />

      <Camera shots={shots} drift={2}>
        {/* mascot */}
        <div
          style={{
            position: "absolute",
            left: MASCOT.x,
            top: MASCOT.y,
            transform: `translate(-50%,-50%) scale(${interpolate(mascot, [0, 1], [0.5, 1])})`,
            opacity: mascot,
          }}
        >
          <Mascot size={188} />
        </div>

        {/* wordmark */}
        <div style={{ position: "absolute", left: WORD.x, top: WORD.y, transform: "translate(-50%,-50%)" }}>
          <Wordmark size={140} delay={18} />
        </div>

        {/* tagline */}
        <div
          style={{
            position: "absolute",
            left: TAG.x,
            top: TAG.y,
            transform: `translate(-50%,-50%) translateY(${interpolate(line, [0, 1], [22, 0])}px)`,
            opacity: line,
            fontFamily: INTER,
            fontWeight: 700,
            fontSize: 42,
            color: COLORS.textMuted,
            whiteSpace: "nowrap",
          }}
        >
          <span style={{ color: COLORS.green }}>Enhance</span> your Discord messages.
        </div>
      </Camera>

      <Sequence from={4} durationInFrames={20}>
        <Audio src={staticFile(POP)} volume={0.55} />
      </Sequence>
    </AbsoluteFill>
  );
};
