import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import { Background } from "../components/Background";
import { Camera, Shot, useVertical } from "../components/Camera";
import { Caption } from "../components/Caption";
import { ActionBar, AppTabs, AppWindow, TreeRow } from "../components/AppUI";
import {
  DBody,
  DBtn,
  DContainer,
  DGallery,
  DHeading,
  DMsg,
} from "../components/DiscordUI";
import { Mascot } from "../components/Mascot";
import { Wordmark } from "../components/Wordmark";
import { useSpr } from "../components/Bits";
import { CHIME, POP, SCENES, voDelay, WHOOSH } from "../timeline";
import { COLORS } from "../theme";
import { INTER } from "../fonts";

const MESSAGE_TITLE = "Season 4 is live";
const MESSAGE_BODY = "New maps, ranked rewards, and a fresh battle pass.";
const MESSAGE_REWARD = "Jump in and claim your founder badge before the weekend.";

/**
 * REVEAL — the rich card from the hook holds its exact screen position while
 * the DWEEB editor physically assembles around it: preview surface first, then
 * the chrome drops in, the builder pane slides in, and the component tree
 * populates. The product is literally built around the message — cause, not
 * cutaway.
 */
export const SceneReveal: React.FC = () => {
  const vert = useVertical();
  const d = voDelay("reveal");

  // Assembly starts as the dissolve ends, so the cross-fade only ever blends
  // the two matched cards — never a fully-drawn editor over the hook shot.
  const chromeIn = useSpr(d - 5, { damping: 19, stiffness: 140, mass: 0.7 });
  const leftIn = useSpr(d + 2, { damping: 19, stiffness: 135, mass: 0.75 });

  const brandIn = useSpr(d + 6, { damping: 17, stiffness: 155 });
  const containerIn = useSpr(d + 26, { damping: 17, stiffness: 150 });
  const textIn = useSpr(d + 36, { damping: 17, stiffness: 150 });
  const galleryIn = useSpr(d + 46, { damping: 17, stiffness: 150 });
  const buttonsIn = useSpr(d + 56, { damping: 17, stiffness: 150 });
  const previewTagIn = useSpr(d + 14, { damping: 18, stiffness: 150 });

  // Start locked on the exact screen framing the hook ended on (the card sits
  // dead-center on both sides of the dissolve), then pull wide once the shell
  // has assembled.
  const shots: Shot[] = vert
    ? [
        { f: 0, x: 1286, y: 462, s: 1.0 },
        { f: d + 10, x: 1286, y: 462, s: 1.03 },
        { f: d + 58, x: 430, y: 490, s: 1.08 },
        { f: d + 108, x: 750, y: 510, s: 0.9 },
        { f: SCENES.reveal.durationInFrames - 18, x: 750, y: 510, s: 0.93 },
      ]
    : [
        { f: 0, x: 1286, y: 428, s: 1.2 },
        { f: d + 10, x: 1286, y: 428, s: 1.22 },
        { f: d + 64, x: 960, y: 520, s: 1.01 },
        { f: SCENES.reveal.durationInFrames - 18, x: 960, y: 520, s: 1.05 },
      ];

  return (
    <AbsoluteFill>
      <Background glow="dual" />
      <Camera shots={shots} blur={0.45}>
        <AbsoluteFill style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ position: "relative" }}>
            <AppWindow
              width={1760}
              height={930}
              leftWidth={600}
              assembly={{ chrome: chromeIn, left: leftIn }}
              left={
                <>
                  <div
                    style={{
                      minHeight: 82,
                      display: "flex",
                      alignItems: "center",
                      gap: 15,
                      opacity: brandIn,
                      transform: `translateY(${(1 - brandIn) * 16}px)`,
                    }}
                  >
                    <div
                      style={{
                        width: 64,
                        height: 64,
                        borderRadius: 18,
                        background: `linear-gradient(145deg, ${COLORS.blurple}, ${COLORS.blurpleHover})`,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        boxShadow: `0 14px 40px ${COLORS.blurple}4d`,
                        flexShrink: 0,
                      }}
                    >
                      <Mascot size={55} glow={false} look={false} />
                    </div>
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "flex-start",
                        gap: 4,
                      }}
                    >
                      <Wordmark size={52} delay={d + 4} underline={false} />
                      <span
                        style={{
                          color: COLORS.textMuted,
                          fontFamily: INTER,
                          fontSize: 14,
                          fontWeight: 680,
                          letterSpacing: ".02em",
                        }}
                      >
                        Visual Discord message builder
                      </span>
                    </div>
                  </div>

                  <ActionBar />
                  <AppTabs />
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <TreeRow icon="▤" label="Container" depth={0} sel reveal={containerIn} />
                    <TreeRow icon="¶" label="Text" depth={1} reveal={textIn} />
                    <TreeRow icon="▦" label="Media Gallery" depth={1} reveal={galleryIn} />
                    <TreeRow icon="⬚" label="Buttons Row" depth={1} reveal={buttonsIn} />
                  </div>
                </>
              }
              right={
                <div style={{ width: 920, marginTop: 58, position: "relative" }}>
                  <div
                    style={{
                      position: "absolute",
                      right: 0,
                      top: -42,
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 12px",
                      borderRadius: 999,
                      color: COLORS.dTextMuted,
                      background: "rgba(0,0,0,.25)",
                      border: `1px solid ${COLORS.dBgTertiary}`,
                      fontFamily: INTER,
                      fontSize: 11.5,
                      fontWeight: 820,
                      letterSpacing: ".09em",
                      opacity: previewTagIn,
                      transform: `translateY(${(1 - previewTagIn) * 8}px)`,
                    }}
                  >
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: "50%",
                        background: COLORS.green,
                        boxShadow: `0 0 12px ${COLORS.green}`,
                      }}
                    />
                    LIVE PREVIEW
                  </div>

                  <DMsg author="Nebula Gaming" mascot time="Today at 9:41 AM">
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
                  </DMsg>
                </div>
              }
            />

          </div>
        </AbsoluteFill>
      </Camera>

      {/* the shell sliding together gets a soft air movement, then the brand
          lands with a pop and the finished assembly rings out */}
      <Sequence from={d - 4} durationInFrames={16}>
        <Audio src={staticFile(WHOOSH)} volume={0.16} />
      </Sequence>
      <Sequence from={d + 7} durationInFrames={18}>
        <Audio src={staticFile(POP)} volume={0.62} />
      </Sequence>
      <Sequence from={d + 72} durationInFrames={26}>
        <Audio src={staticFile(CHIME)} volume={0.5} />
      </Sequence>

      <Caption
        label="ONE VISUAL BUILDER"
        parts={["webhooks · embeds ·", { hl: "Components V2" }]}
        delay={d + 72}
        out={SCENES.reveal.durationInFrames - 22}
        accent={COLORS.blurple}
      />
    </AbsoluteFill>
  );
};
