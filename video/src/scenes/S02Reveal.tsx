import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame, interpolate } from "remotion";
import { Background } from "../components/Background";
import { Camera, Shot, useVertical } from "../components/Camera";
import { Mascot } from "../components/Mascot";
import { Wordmark } from "../components/Wordmark";
import { Rise, Chip, useSpr } from "../components/Bits";
import { voDelay, POP, CHIME } from "../timeline";
import { COLORS } from "../theme";
import { INTER } from "../fonts";

/** REVEAL — the brand card: mascot drop, wordmark, tagline, URL. */
export const SceneReveal: React.FC = () => {
  const frame = useCurrentFrame();
  const vert = useVertical();
  const d = voDelay("reveal");

  const drop = useSpr(6, { damping: 12, stiffness: 120, mass: 0.8 });
  const squash = interpolate(Math.min(frame, 26), [16, 20, 26], [1, 0.88, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // The brand column fits portrait natively — just a touch more zoom so the
  // lockup carries the tall frame (tagline ~820 world px sets the width cap).
  const shots: Shot[] = vert
    ? [
        { f: 0, x: 960, y: 520, s: 1.24 },
        { f: 60, x: 960, y: 540, s: 1.12 },
        { f: 140, x: 960, y: 540, s: 1.16 },
      ]
    : [
        { f: 0, x: 960, y: 520, s: 1.16 },
        { f: 60, x: 960, y: 540, s: 1.0 },
        { f: 140, x: 960, y: 540, s: 1.03 },
      ];

  return (
    <AbsoluteFill>
      <Background glow="dual" />
      <Camera shots={shots} drift={3}>
        <AbsoluteFill style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 34 }}>
            <div
              style={{
                opacity: drop,
                transform: `translateY(${interpolate(drop, [0, 1], [-260, 0])}px) scaleY(${squash})`,
                transformOrigin: "bottom center",
              }}
            >
              <Mascot size={300} />
            </div>
            <Wordmark size={150} delay={14} />
            <Rise delay={30}>
              <div
                style={{
                  fontFamily: INTER,
                  fontSize: 34,
                  fontWeight: 600,
                  color: COLORS.textMuted,
                  letterSpacing: "0.01em",
                }}
              >
                The <span style={{ color: COLORS.text, fontWeight: 800 }}>ultimate toolkit</span> for fancy
                Discord messages
              </div>
            </Rise>
            <Rise delay={44}>
              <div style={{ display: "flex", gap: 14 }}>
                <Chip icon="globe" color={COLORS.green} big>
                  dweeb.faizo.net
                </Chip>
                <Chip icon="blocks" color={COLORS.blurple} big>
                  Discord Components V2
                </Chip>
              </div>
            </Rise>
          </div>
        </AbsoluteFill>
      </Camera>

      <Sequence from={16} durationInFrames={16}>
        <Audio src={staticFile(POP)} volume={0.7} />
      </Sequence>
      <Sequence from={30} durationInFrames={24}>
        <Audio src={staticFile(CHIME)} volume={0.5} />
      </Sequence>
    </AbsoluteFill>
  );
};
