import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame, interpolate } from "remotion";
import { Background } from "../components/Background";
import { Camera, Shot, useVertical } from "../components/Camera";
import { Caption } from "../components/Caption";
import { Cursor } from "../components/Cursor";
import {
  AppWindow,
  ActionBar,
  AppTabs,
  TreeRow,
  AddComponentBtn,
  IssuePill,
} from "../components/AppUI";
import {
  DMsg,
  DContainer,
  DHeading,
  DBody,
  DGallery,
  DBtn,
  DSelect,
} from "../components/DiscordUI";
import { TypeText, useSpr, cursorAt, Waypoint, PulseRing } from "../components/Bits";
import { voDelay, SCENES, CLICK, POP, CHIME, TICK } from "../timeline";
import { COLORS } from "../theme";

/**
 * BUILD — continues from the selected Announcement template and personalizes
 * it: retitle the heading, check the gallery, then add a reward button and a
 * platform select through the real "Add component" flow. Every edit lights up
 * in the tree and lands in the preview at once. The scene's end state (layout,
 * tree, camera) is pixel-matched to the assistant scene, which continues the
 * same take across an invisible cut.
 */
export const SceneBuild: React.FC = () => {
  const frame = useCurrentFrame();
  const vert = useVertical();
  const d = voDelay("build");

  const tHeadline = d + 34;
  const tGallery = d + 72;
  const tButton = d + 108;
  const tSelect = d + 140;
  const tReady = d + 172;

  const headlineIn = useSpr(tHeadline, { damping: 20, stiffness: 150 });
  const galleryFocus = useSpr(tGallery, { damping: 18, stiffness: 145 });
  const buttonIn = useSpr(tButton + 4, { damping: 16, stiffness: 155 });
  const selectIn = useSpr(tSelect + 4, { damping: 17, stiffness: 150 });
  const readyIn = useSpr(tReady, { damping: 15, stiffness: 165 });

  // The tree label tracks the heading as it is typed — the node name derives
  // from content in the real app.
  const typedTitle = "Season 4 is live".slice(
    0,
    Math.max(0, Math.floor(((frame - tHeadline) / 30) * 28)),
  );

  // Selection follows the work, then clears so the boundary frame into the
  // assistant scene is identical on both sides of the hold cut.
  const active =
    frame >= tReady
      ? "none"
      : frame >= tSelect
        ? "select"
        : frame >= tButton
          ? "button"
          : frame >= tGallery
            ? "gallery"
            : "text";

  // Both component additions go through the real Add-component button.
  // Dwell at each control, then hop in a short confident move — never a crawl.
  const addBtn = { x: 380, y: 953 };
  const waypoints: Waypoint[] = [
    { f: d + 4, x: 470, y: 300 },
    { f: tHeadline - 18, x: 470, y: 300 },
    { f: tHeadline - 4, x: 350, y: 353 },
    { f: tHeadline, x: 350, y: 353, press: true },
    { f: tGallery - 16, x: 350, y: 353 },
    { f: tGallery - 4, x: 350, y: 402 },
    { f: tGallery, x: 350, y: 402, press: true },
    { f: tButton - 22, x: 350, y: 402 },
    { f: tButton - 4, x: addBtn.x, y: addBtn.y },
    { f: tButton, x: addBtn.x, y: addBtn.y, press: true },
    { f: tButton + 18, x: 430, y: 908 },
    { f: tSelect - 16, x: 430, y: 908 },
    { f: tSelect - 4, x: addBtn.x, y: addBtn.y },
    { f: tSelect, x: addBtn.x, y: addBtn.y, press: true },
    { f: tSelect + 12, x: addBtn.x, y: addBtn.y },
    { f: tReady, x: 1150, y: 480 },
  ];
  const cursor = cursorAt(frame, waypoints);

  const pill = vert ? { x: 1560, y: 169 } : { x: 1700, y: 171 };

  // Vertical can't frame the tree and the card at once, so it makes ONE trip:
  // card (typing, gallery) → tree (BOTH Add-component clicks, whose new rows
  // pop right there) → card+pill. Ping-ponging per click read as whiplash.
  const shots: Shot[] = vert
    ? [
        { f: 0, x: 390, y: 470, s: 1.7 },
        { f: tHeadline - 8, x: 1220, y: 360, s: 1.5 },
        { f: tGallery + 2, x: 1220, y: 440, s: 1.5 },
        { f: tButton - 14, x: 480, y: 700, s: 1.55 },
        { f: tSelect + 4, x: 480, y: 700, s: 1.55 },
        { f: tSelect + 30, x: 1290, y: 440, s: 1.45 },
        { f: tReady + 10, x: 1290, y: 440, s: 1.45 },
        { f: SCENES.build.durationInFrames + 12, x: 1440, y: 430, s: 1.72 },
      ]
    : [
        { f: 0, x: 900, y: 510, s: 1.08 },
        { f: tHeadline - 8, x: 850, y: 385, s: 1.3 },
        { f: tGallery + 2, x: 850, y: 445, s: 1.27 },
        { f: tButton - 6, x: 830, y: 690, s: 1.22 },
        { f: tSelect + 8, x: 860, y: 680, s: 1.2 },
        { f: tReady, x: 1000, y: 500, s: 1.08 },
      ];

  const galleryPulse =
    frame >= tGallery && frame < tGallery + 30
      ? 1 + Math.sin(((frame - tGallery) / 30) * Math.PI) * 0.025
      : 1;

  return (
    <AbsoluteFill>
      <Background glow="dual" />
      <Camera shots={shots}>
        <AbsoluteFill style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ position: "relative" }}>
            <AppWindow
              width={1680}
              height={900}
              leftWidth={520}
              left={
                <>
                  <ActionBar />
                  <AppTabs />
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 7,
                      flex: 1,
                      minHeight: 0,
                    }}
                  >
                    <TreeRow icon="▤" label="Container" depth={0} />
                    <TreeRow icon="◧" label="Section" depth={1} />
                    <TreeRow
                      icon="¶"
                      label={frame < tHeadline ? "Text — Season 4 launch" : `Text — ${typedTitle}`}
                      depth={2}
                      sel={active === "text"}
                    />
                    <TreeRow icon="▦" label="Media Gallery" depth={1} sel={active === "gallery"} />
                    <TreeRow icon="⬚" label="Buttons Row" depth={1} />
                    <TreeRow icon="▢" label="Button — Patch notes" depth={2} />
                    <TreeRow
                      icon="▢"
                      label="Button — Claim reward"
                      depth={2}
                      sel={active === "button"}
                      reveal={buttonIn}
                    />
                    <TreeRow
                      icon="☰"
                      label="String Select"
                      depth={1}
                      sel={active === "select"}
                      reveal={selectIn}
                    />
                    <div style={{ marginTop: "auto" }}>
                      <AddComponentBtn
                        glow={
                          (frame >= tButton - 16 && frame < tButton + 14) ||
                          (frame >= tSelect - 16 && frame < tSelect + 14)
                        }
                      />
                    </div>
                  </div>
                </>
              }
              right={
                <div
                  style={{
                    width: "100%",
                    display: "flex",
                    justifyContent: "center",
                    marginTop: 18,
                  }}
                >
                  {/* Exactly CampaignPreview's geometry, so the hold cut into
                      the assistant scene lands on an identical frame. */}
                  <div
                    style={{
                      width: "100%",
                      maxWidth: 720,
                      transform: "scale(0.98)",
                      transformOrigin: "top center",
                    }}
                  >
                    <DMsg author="Nebula Gaming" mascot time="live preview">
                      <DContainer accent={COLORS.green}>
                        <div
                          style={{
                            minHeight: 27,
                            opacity: interpolate(headlineIn, [0, 1], [0.8, 1]),
                            transform: `translateY(${interpolate(headlineIn, [0, 1], [5, 0])}px)`,
                          }}
                        >
                          {frame < tHeadline ? (
                            <DHeading icon="rocket">Season 4 launch</DHeading>
                          ) : (
                            <DHeading icon="rocket">
                              <TypeText text="Season 4 is live" start={tHeadline} cps={28} />
                            </DHeading>
                          )}
                        </div>
                        <DBody>
                          New maps, ranked rewards, and a fresh battle pass. Jump in and claim your
                          founder badge before the weekend.
                        </DBody>
                        <div
                          style={{
                            transform: `scale(${galleryPulse})`,
                            transformOrigin: "center",
                            filter:
                              galleryFocus < 0.99
                                ? `saturate(${0.86 + galleryFocus * 0.14})`
                                : undefined,
                          }}
                        >
                          <DGallery h={150} />
                        </div>
                        <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
                          <DBtn label="Patch notes" kind="primary" />
                          {buttonIn > 0.01 && (
                            <div
                              style={{
                                opacity: buttonIn,
                                transform: `translateX(${(1 - buttonIn) * 18}px) scale(${0.92 + buttonIn * 0.08})`,
                              }}
                            >
                              <DBtn
                                label="Claim reward"
                                kind="success"
                                emoji="🎁"
                                // vertical pans back from the tree later, so the
                                // fresh button stays lit until it is seen
                                glow={frame < (vert ? tReady + 4 : tButton + 38)}
                              />
                            </div>
                          )}
                        </div>
                        {selectIn > 0.01 && (
                          <div
                            style={{
                              opacity: selectIn,
                              transform: `translateY(${(1 - selectIn) * 14}px)`,
                            }}
                          >
                            <DSelect placeholder="Choose your platform…" />
                          </div>
                        )}
                      </DContainer>
                    </DMsg>
                  </div>
                </div>
              }
            />
            <div style={{ position: "absolute", top: 62, right: vert ? 170 : 28 }}>
              <IssuePill count={0} ok reveal={readyIn} />
            </div>
          </div>

          {frame >= d && frame < tReady + 16 && (
            <Cursor x={cursor.x} y={cursor.y} pressed={cursor.pressed} size={30} />
          )}
          <PulseRing x={pill.x} y={pill.y} start={tReady} color={COLORS.green} />
        </AbsoluteFill>
      </Camera>

      <Sequence from={tHeadline} durationInFrames={10}>
        <Audio src={staticFile(CLICK)} volume={0.55} />
      </Sequence>
      {[0, 1, 2, 3].map((i) => (
        <Sequence key={i} from={tHeadline + 3 + i * 4} durationInFrames={4}>
          <Audio src={staticFile(TICK)} volume={0.2} />
        </Sequence>
      ))}
      <Sequence from={tGallery} durationInFrames={10}>
        <Audio src={staticFile(POP)} volume={0.48} />
      </Sequence>
      {[tButton, tSelect].map((at) => (
        <React.Fragment key={at}>
          <Sequence from={at} durationInFrames={8}>
            <Audio src={staticFile(CLICK)} volume={0.62} />
          </Sequence>
          <Sequence from={at + 5} durationInFrames={10}>
            <Audio src={staticFile(POP)} volume={0.5} />
          </Sequence>
        </React.Fragment>
      ))}
      <Sequence from={tReady} durationInFrames={24}>
        <Audio src={staticFile(CHIME)} volume={0.58} />
      </Sequence>

      <Caption
        label="Design with confidence"
        parts={["Real blocks.", { hl: "Live preview." }]}
        delay={d + 10}
        out={SCENES.build.durationInFrames - 18}
        accent={COLORS.blurple}
      />
    </AbsoluteFill>
  );
};
