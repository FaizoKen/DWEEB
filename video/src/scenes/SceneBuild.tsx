import React from "react";
import {
  AbsoluteFill,
  Audio,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Easing,
} from "remotion";
import { Background } from "../components/Background";
import { Camera, Shot } from "../components/Camera";
import { AppFrame } from "../components/AppFrame";
import { EditorPane } from "../components/EditorPane";
import { DiscordPreview } from "../components/DiscordPreview";
import { Caption } from "../components/Caption";
import { Cursor } from "../components/Cursor";
import { COLORS } from "../theme";
import { INTER } from "../fonts";
import { CLICK } from "../timeline";

// App geometry in world space (centered in the 1920×1080 frame).
const APP = { x: 80, y: 80, w: 1760, h: 920 };
const PANE_W = 560;

// Cursor click moments (scene-relative), each one drops the next tree node in.
const CLICKS = [40, 70, 100, 130];

export const SceneBuild: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Tree builds as the cursor clicks "Add component"; preview fills a beat later.
  const treeRevealed = CLICKS.filter((c) => frame >= c + 3).length + 1;
  const previewShow = Math.min(
    3,
    Math.floor(interpolate(frame, [120, 215], [0, 3.4], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })),
  );

  // Cursor: hammers the "Add component" pill, then sweeps into the live preview.
  const addBtn = { x: APP.x + 280, y: APP.y + 872 };
  const previewTarget = { x: 1180, y: 720 };
  const cx = interpolate(
    frame,
    [0, 30, 130, 175],
    [APP.x + 420, addBtn.x, addBtn.x, previewTarget.x],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.quad) },
  );
  const cy = interpolate(
    frame,
    [0, 30, 130, 175],
    [APP.y + 500, addBtn.y, addBtn.y, previewTarget.y],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.quad) },
  );
  const pressed = CLICKS.some((c) => frame >= c && frame < c + 6);

  // Camera: establish → push to favour the editor as it builds (app still fills
  // the frame, so the live preview is always reacting on the right) → glide to
  // the preview and punch in → ease back to show both halves in sync.
  const { width, height } = useVideoConfig();
  const vertical = height > width;

  const shotsH: Shot[] = [
    { f: 0, x: 960, y: 540, s: 0.95 },
    { f: 36, x: 880, y: 560, s: 1.12 },
    { f: 120, x: 880, y: 640, s: 1.12 },
    { f: 150, x: 1170, y: 560, s: 1.16, ease: Easing.bezier(0.5, 0, 0.1, 1) },
    { f: 215, x: 1170, y: 575, s: 1.18 },
    { f: 255, x: 960, y: 540, s: 1.0 },
    { f: 300, x: 960, y: 540, s: 1.0 },
  ];
  // Portrait: the app is wide and short, so we can't show both halves legibly.
  // Establish the whole app filling the width, push onto the editor pane as the
  // tree builds, glide to the live preview, then pull back.
  const shotsV: Shot[] = [
    { f: 0, x: 960, y: 540, s: 0.6 },
    { f: 36, x: 380, y: 540, s: 1.42 },
    { f: 120, x: 380, y: 640, s: 1.42 },
    { f: 150, x: 1245, y: 540, s: 1.4, ease: Easing.bezier(0.5, 0, 0.1, 1) },
    { f: 215, x: 1245, y: 560, s: 1.42 },
    { f: 255, x: 960, y: 540, s: 0.6 },
    { f: 300, x: 960, y: 540, s: 0.6 },
  ];
  const shots = vertical ? shotsV : shotsH;

  return (
    <AbsoluteFill>
      <Background glow="dual" />

      <Camera shots={shots} drift={2}>
        <div style={{ position: "absolute", left: APP.x, top: APP.y }}>
          <AppFrame width={APP.w} height={APP.h}>
            <div style={{ display: "flex", height: "100%" }}>
              <div style={{ width: PANE_W, borderRight: `1px solid ${COLORS.border}` }}>
                <EditorPane revealed={treeRevealed} />
              </div>
              <div
                style={{
                  flex: 1,
                  background: COLORS.dBgPrimary,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 40,
                  position: "relative",
                }}
              >
                <DiscordPreview show={previewShow} width={820} />
                <div
                  style={{
                    position: "absolute",
                    top: 22,
                    right: 26,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    background: "rgba(0,0,0,0.45)",
                    borderRadius: 999,
                    padding: "6px 14px",
                    fontFamily: INTER,
                    fontWeight: 700,
                    fontSize: 15,
                    color: "#fff",
                  }}
                >
                  <div
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      background: COLORS.danger,
                      opacity: 0.6 + 0.4 * Math.sin(frame / 5),
                      boxShadow: `0 0 10px ${COLORS.danger}`,
                    }}
                  />
                  LIVE PREVIEW
                </div>
              </div>
            </div>
          </AppFrame>
        </div>

        <Cursor x={cx} y={cy} pressed={pressed} />
      </Camera>

      {CLICKS.map((c) => (
        <Sequence key={c} from={c} durationInFrames={12}>
          <Audio src={staticFile(CLICK)} volume={0.4} />
        </Sequence>
      ))}

      <Caption parts={["Design it visually — ", { hl: "live preview" }, ", no code."]} delay={10} accent={COLORS.green} />
    </AbsoluteFill>
  );
};
