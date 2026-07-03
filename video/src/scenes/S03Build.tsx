import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame } from "remotion";
import { Background } from "../components/Background";
import { Camera, Shot, useVertical } from "../components/Camera";
import { Caption } from "../components/Caption";
import { AppWindow, ActionBar, AppTabs, TreeRow, AddComponentBtn, IssuePill } from "../components/AppUI";
import { DMsg, DContainer, DHeading, DBody, DGallery, DBtn, DSelect } from "../components/DiscordUI";
import { useSpr } from "../components/Bits";
import { voDelay, SCENES, POP, CHIME } from "../timeline";
import { COLORS } from "../theme";

/**
 * BUILD — the core editor: the component tree assembles (palette names are the
 * real ones from metadata.ts), every block lands complete, the pixel-accurate
 * preview mirrors each one, and on the "limits" beat the floating header pill
 * confirms the message is within Discord's rules — no fix-it detour.
 */
export const SceneBuild: React.FC = () => {
  const frame = useCurrentFrame();
  const vert = useVertical();
  const d = voDelay("build");

  // Beats synced to the narration.
  const tContainer = d + 64;
  const tSection = d + 88;
  const tGallery = d + 114;
  const tButtons = d + 138;
  const tSelect = d + 160;
  const tReady = d + 330; // "…enforces Discord's limits" → the green pill pops

  const r = (at: number) => useSpr(at, { damping: 15, stiffness: 140 });
  const rContainer = r(tContainer);
  const rSection = r(tSection);
  const rText = r(tSection + 12);
  const rGallery = r(tGallery);
  const rButtons = r(tButtons);
  const rButton = r(tButtons + 12);
  const rSelect = r(tSelect);

  const okIn = useSpr(tReady);

  // The camera follows the narration with slow, gentle glides — close on the
  // tree while blocks land, easing out just enough to take in the preview,
  // then wide before the limits beat so the pill pops in full view. Every
  // move spans 30+ frames. Portrait can't hold both panes at once, so it
  // establishes the whole editor, then pans pane-to-pane with the narration.
  const shots: Shot[] = vert
    ? [
        { f: 0, x: 960, y: 540, s: 0.6 }, // establish the whole editor
        { f: d + 52, x: 368, y: 480, s: 1.5 }, // the tree, as blocks land
        { f: d + 160, x: 368, y: 480, s: 1.5 },
        { f: d + 200, x: 1240, y: 460, s: 1.28 }, // across to the live preview
        { f: d + 264, x: 1240, y: 460, s: 1.28 },
        { f: d + 312, x: 1350, y: 390, s: 1.15 }, // preview + the header pill
      ]
    : [
        { f: 0, x: 960, y: 540, s: 1.0 },
        { f: d + 52, x: 660, y: 460, s: 1.26 }, // slow push onto the tree as blocks land
        { f: d + 160, x: 660, y: 460, s: 1.26 },
        { f: d + 200, x: 900, y: 470, s: 1.2 }, // ease out: tree AND preview in frame
        { f: d + 264, x: 900, y: 470, s: 1.2 }, // hold: the preview mirrors the tree
        { f: d + 312, x: 960, y: 540, s: 1.05 }, // wide before the limits beat
      ];

  return (
    <AbsoluteFill>
      <Background glow="dual" />
      <Camera shots={shots}>
        <AbsoluteFill style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ position: "relative" }}>
            <AppWindow
              width={1760}
              height={950}
              left={
                <>
                  <ActionBar />
                  <AppTabs />
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1, minHeight: 0 }}>
                    <TreeRow icon="▤" label="Container" depth={0} reveal={rContainer} />
                    <TreeRow icon="◧" label="Section" depth={1} reveal={rSection} />
                    <TreeRow icon="¶" label="Text" depth={2} reveal={rText} />
                    <TreeRow icon="▦" label="Media Gallery" depth={1} reveal={rGallery} />
                    <TreeRow icon="⬚" label="Buttons Row" depth={1} reveal={rButtons} />
                    <TreeRow icon="▢" label="Button — Claim reward" depth={2} reveal={rButton} />
                    <TreeRow icon="☰" label="String Select" depth={1} reveal={rSelect} />
                    <div style={{ marginTop: "auto" }}>
                      <AddComponentBtn glow={frame > d + 30 && frame < tSelect + 20} />
                    </div>
                  </div>
                </>
              }
              right={
                <div style={{ width: "100%", maxWidth: 760, marginTop: 12 }}>
                  <DMsg author="Nebula Announcements" mascot>
                    <div style={{ opacity: rContainer }}>
                      <DContainer accent={COLORS.green}>
                        {rSection > 0.05 && (
                          <div style={{ opacity: rSection }}>
                            <DHeading icon="rocket">Season 4 is live</DHeading>
                          </div>
                        )}
                        {rText > 0.05 && (
                          <div style={{ opacity: rText }}>
                            <DBody>
                              New maps, ranked rewards, and a fresh battle pass. Jump in and claim
                              your founder badge before the weekend.
                            </DBody>
                          </div>
                        )}
                        {rGallery > 0.05 && (
                          <div style={{ opacity: rGallery, transform: `translateY(${(1 - rGallery) * 14}px)` }}>
                            <DGallery h={150} />
                          </div>
                        )}
                        {rButtons > 0.05 && (
                          <div style={{ display: "flex", gap: 9, opacity: rButton }}>
                            <DBtn label="Claim reward" kind="success" emoji="🎁" />
                            <DBtn label="Patch notes" kind="primary" />
                          </div>
                        )}
                        {rSelect > 0.05 && (
                          <div style={{ opacity: rSelect, transform: `translateY(${(1 - rSelect) * 12}px)` }}>
                            <DSelect placeholder="Choose your platform…" />
                          </div>
                        )}
                      </DContainer>
                    </div>
                  </DMsg>
                </div>
              }
            />
            {/* the floating header pill (over the preview, clear of the bar) —
                pops green on the "limits" beat: nothing to fix, just enforced */}
            <div style={{ position: "absolute", top: 58, right: 30 }}>
              <IssuePill count={0} ok reveal={okIn} />
            </div>
          </div>
        </AbsoluteFill>
      </Camera>

      {[tContainer, tSection, tGallery, tButtons, tSelect].map((t, i) => (
        <Sequence key={i} from={t} durationInFrames={14}>
          <Audio src={staticFile(POP)} volume={0.5} />
        </Sequence>
      ))}
      <Sequence from={tReady} durationInFrames={24}>
        <Audio src={staticFile(CHIME)} volume={0.55} />
      </Sequence>

      <Caption
        parts={["Real Discord blocks.", { hl: "Pixel-accurate preview." }, "Limits enforced."]}
        delay={d + 24}
        out={SCENES.build.durationInFrames - 26}
        accent={COLORS.blurple}
      />
    </AbsoluteFill>
  );
};
