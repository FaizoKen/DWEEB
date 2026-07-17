import React from "react";
import { AbsoluteFill, Audio, Sequence, interpolate, staticFile, useCurrentFrame } from "remotion";
import { Background } from "../components/Background";
import { Camera, Shot, useVertical } from "../components/Camera";
import { Caption } from "../components/Caption";
import { DBody, DBtn, DContainer, DGallery, DHeading, DMsg } from "../components/DiscordUI";
import { Icon } from "../components/Icon";
import { useSpr } from "../components/Bits";
import { PING, SCENES, WHOOSH, voDelay } from "../timeline";
import { COLORS } from "../theme";
import { INTER } from "../fonts";

const MESSAGE_TITLE = "Season 4 is live";
const MESSAGE_BODY = "New maps, ranked rewards, and a fresh battle pass.";
const MESSAGE_REWARD = "Jump in and claim your founder badge before the weekend.";

/**
 * HOOK — one deliberately plain Discord message transforms in place into a
 * visual, interactive one. There is no channel story and no competing chat:
 * the opening contrast is simply the message before and after DWEEB.
 *
 * The finished card keeps the previous production's verified end position so
 * the reveal scene can still build the editor around it in a matched dissolve.
 */
export const SceneHook: React.FC = () => {
  const frame = useCurrentFrame();
  const vert = useVertical();
  const d = voDelay("hook");

  // The turn lands on "Let's turn it into something better."
  const turn = d + 56;
  const richAt = turn + 5;
  const plainOut = useSpr(turn, { damping: 22, mass: 0.52, stiffness: 210 });
  const richIn = useSpr(richAt, { damping: 15, mass: 0.58, stiffness: 175 });
  const sweep = interpolate(frame, [turn - 2, turn + 18], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const shots: Shot[] = vert
    ? [
        { f: 0, x: 760, y: 470, s: 1.04 },
        { f: d + 16, x: 760, y: 462, s: 1.06 },
        { f: turn - 8, x: 760, y: 442, s: 1.1 },
        { f: richAt + 15, x: 770, y: 505, s: 1.0 },
        { f: SCENES.hook.durationInFrames - 10, x: 750, y: 502, s: 1.0 },
      ]
    : [
        { f: 0, x: 760, y: 475, s: 1.24 },
        { f: d + 16, x: 760, y: 466, s: 1.27 },
        { f: turn - 8, x: 760, y: 438, s: 1.31 },
        { f: richAt + 15, x: 770, y: 505, s: 1.18 },
        { f: SCENES.hook.durationInFrames - 10, x: 751, y: 468, s: 1.2 },
      ];

  const upgraded = frame >= richAt;

  return (
    <AbsoluteFill>
      <Background glow="blurple" />
      <Camera shots={shots} blur={0.35}>
        <AbsoluteFill style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div
            style={{
              width: 1580,
              height: 820,
              borderRadius: 24,
              overflow: "hidden",
              background: COLORS.dBgPrimary,
              border: `1px solid ${COLORS.dBgTertiary}`,
              boxShadow: "0 46px 150px rgba(0,0,0,.68)",
              fontFamily: INTER,
              position: "relative",
            }}
          >
            <div
              style={{
                height: 64,
                padding: "0 74px",
                display: "flex",
                alignItems: "center",
                gap: 11,
                color: "#fff",
                borderBottom: `1px solid ${COLORS.dBgTertiary}`,
                background: `${COLORS.dBgSecondary}f2`,
                position: "relative",
                zIndex: 2,
              }}
            >
              <Icon name="eye" size={21} color={upgraded ? COLORS.green : COLORS.dTextMuted} />
              <span style={{ fontSize: 18, fontWeight: 760 }}>Message makeover</span>
              <span
                style={{
                  marginLeft: "auto",
                  padding: "5px 10px",
                  borderRadius: 999,
                  color: upgraded ? COLORS.green : COLORS.dTextMuted,
                  background: upgraded ? `${COLORS.green}18` : "rgba(255,255,255,.045)",
                  border: `1px solid ${upgraded ? `${COLORS.green}55` : COLORS.dBgTertiary}`,
                  fontSize: 12,
                  fontWeight: 850,
                  letterSpacing: ".09em",
                }}
              >
                {upgraded ? "UPGRADED" : "PLAIN"}
              </span>
            </div>

            <div style={{ position: "absolute", inset: "64px 0 0", overflow: "hidden" }}>
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  padding: "74px 92px",
                  boxSizing: "border-box",
                  // Keep the rich-card endpoint aligned with S02Reveal.
                  transform: "translateY(-24px)",
                }}
              >
                <DMsg author="Nebula Gaming" mascot time="Today at 9:41 AM">
                  <div style={{ width: 900, height: 495, position: "relative" }}>
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        opacity: interpolate(plainOut, [0, 0.72, 1], [1, 0, 0]),
                        transform: `translateY(${interpolate(plainOut, [0, 1], [0, -18])}px) scale(${interpolate(
                          plainOut,
                          [0, 1],
                          [1, 0.985],
                        )})`,
                        filter:
                          plainOut > 0.05 ? `blur(${(plainOut * 2.2).toFixed(2)}px)` : undefined,
                      }}
                    >
                      <div
                        style={{
                          width: 790,
                          padding: "18px 20px",
                          borderRadius: 10,
                          background: "rgba(255,255,255,.018)",
                          border: `1px solid ${COLORS.dBgTertiary}`,
                        }}
                      >
                        <DBody size={20}>
                          <div style={{ marginBottom: 13 }}>{MESSAGE_TITLE}.</div>
                          <div style={{ marginBottom: 13 }}>{MESSAGE_BODY}</div>
                          <div>{MESSAGE_REWARD}</div>
                        </DBody>
                      </div>
                    </div>

                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        opacity: Math.min(1, richIn * 1.25),
                        transform: `translateY(${interpolate(richIn, [0, 1], [30, 0])}px) scale(${interpolate(
                          richIn,
                          [0, 1],
                          [0.965, 1],
                        )})`,
                        transformOrigin: "top left",
                      }}
                    >
                      <DContainer accent={COLORS.green} width={860}>
                        <DHeading icon="rocket" size={29}>
                          {MESSAGE_TITLE}
                        </DHeading>
                        <DBody size={18}>
                          {MESSAGE_BODY} {MESSAGE_REWARD}
                        </DBody>
                        <DGallery h={176} />
                        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                          <DBtn label="Claim founder badge" kind="success" icon="gift" />
                          <DBtn label="Read the patch notes" kind="primary" icon="notes" />
                          <DBtn label="Enter the launch giveaway" icon="sparkle" />
                        </div>
                      </DContainer>
                    </div>

                    {frame >= turn - 2 && frame <= turn + 22 && (
                      <div
                        style={{
                          position: "absolute",
                          top: -16,
                          bottom: 28,
                          left: 0,
                          width: 160,
                          opacity: interpolate(sweep, [0, 0.25, 0.75, 1], [0, 0.72, 0.5, 0]),
                          transform: `translateX(${interpolate(sweep, [0, 1], [-130, 890])}px) skewX(-12deg)`,
                          background: `linear-gradient(90deg, transparent, ${COLORS.green}28, ${COLORS.blurple}4d, transparent)`,
                          filter: "blur(7px)",
                          pointerEvents: "none",
                        }}
                      />
                    )}
                  </div>
                </DMsg>
              </div>
            </div>

            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                height: 96,
                background: `linear-gradient(transparent, ${COLORS.dBgPrimary})`,
                pointerEvents: "none",
                zIndex: 3,
              }}
            />
          </div>
        </AbsoluteFill>
      </Camera>

      <Sequence from={turn - 2} durationInFrames={22}>
        <Audio src={staticFile(WHOOSH)} volume={0.38} />
      </Sequence>
      <Sequence from={richAt + 7} durationInFrames={20}>
        <Audio src={staticFile(PING)} volume={0.68} />
      </Sequence>

      <Caption
        label="BEFORE"
        parts={[{ hl: "Just plain text." }]}
        delay={d + 5}
        out={turn - 9}
        accent={COLORS.warning}
      />
      <Caption
        label="AFTER"
        parts={["Clear. Visual.", { hl: "Interactive." }]}
        delay={richAt + 8}
        out={SCENES.hook.durationInFrames - 20}
        accent={COLORS.green}
      />
    </AbsoluteFill>
  );
};
