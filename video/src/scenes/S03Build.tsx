import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame, interpolate } from "remotion";
import { Background } from "../components/Background";
import { Camera, Shot } from "../components/Camera";
import { Caption } from "../components/Caption";
import { AppWindow, ActionBar, AppTabs, TreeRow, AddComponentBtn, InspectorCard, Field, IssuePill } from "../components/AppUI";
import { DMsg, DContainer, DHeading, DBody, DGallery, DBtn, DSelect } from "../components/DiscordUI";
import { Cursor } from "../components/Cursor";
import { TypeText, useSpr, cursorAt, Waypoint } from "../components/Bits";
import { voDelay, SCENES, POP, TICK, CHIME, CLICK } from "../timeline";
import { COLORS } from "../theme";

/**
 * BUILD — the core editor: the component tree assembles (palette names are the
 * real ones from metadata.ts), the pixel-accurate preview mirrors every block,
 * and the floating issue pill flags a problem until the inspector fixes it.
 */
export const SceneBuild: React.FC = () => {
  const frame = useCurrentFrame();
  const d = voDelay("build");

  // Beats synced to the narration.
  const tContainer = d + 64;
  const tSection = d + 88;
  const tGallery = d + 114;
  const tButtons = d + 138;
  const tSelect = d + 160;
  const tInspector = d + 235;
  const tType = d + 260; // "Claim reward" types into Label
  const tResolve = d + 340; // limits beat → pill turns green

  const r = (at: number) => useSpr(at, { damping: 15, stiffness: 140 });
  const rContainer = r(tContainer);
  const rSection = r(tSection);
  const rText = r(tSection + 12);
  const rGallery = r(tGallery);
  const rButtons = r(tButtons);
  const rButton = r(tButtons + 12);
  const rSelect = r(tSelect);
  const rInspector = r(tInspector);

  const labelDone = frame > tType + 34;
  const resolved = frame > tResolve;
  const pillIn = useSpr(tButtons + 20);
  const okIn = useSpr(tResolve);

  // The camera follows the narration with slow, gentle glides — close on the
  // tree while blocks land, easing out just enough to take in the preview,
  // then settling on the inspector BEFORE the click — and ends on a zoom-out
  // so the whole editor is seen in sync. Every move spans 30+ frames.
  const shots: Shot[] = [
    { f: 0, x: 960, y: 540, s: 1.0 },
    { f: d + 52, x: 660, y: 460, s: 1.26 }, // slow push onto the tree as blocks land
    { f: d + 160, x: 660, y: 460, s: 1.26 },
    { f: d + 200, x: 900, y: 470, s: 1.2 }, // ease out: tree AND preview in frame
    { f: d + 214, x: 900, y: 470, s: 1.2 },
    { f: tInspector - 2, x: 660, y: 540, s: 1.3 }, // settle on the tree BEFORE the click
    { f: tResolve + 12, x: 660, y: 540, s: 1.3 }, // hold through the fix + resolve
    { f: tResolve + 52, x: 960, y: 540, s: 1.05 }, // zoom out: both halves in sync
  ];

  // The cursor sells the fix: select the flagged Button row, then click into
  // the Label field as it types.
  const waypoints: Waypoint[] = [
    { f: d + 152, x: 900, y: 700 },
    { f: tInspector - 10, x: 340, y: 481 }, // the Button row
    { f: tInspector, x: 340, y: 481, press: true },
    { f: tInspector + 6, x: 340, y: 481 },
    { f: tType - 6, x: 280, y: 630 }, // the inspector's Label field
    { f: tType - 2, x: 280, y: 630, press: true },
    { f: tType + 42, x: 300, y: 642 },
    { f: tResolve + 18, x: 700, y: 560 },
  ];
  const cur = cursorAt(frame, waypoints);

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
                    <TreeRow
                      icon="▢"
                      label={labelDone ? "Button — Claim reward" : "Button"}
                      depth={2}
                      sel={frame > tInspector}
                      issue={!resolved && frame > tButtons + 16}
                      reveal={rButton}
                    />
                    <TreeRow icon="☰" label="String Select" depth={1} reveal={rSelect} />

                    {frame > tInspector && (
                      <div style={{ opacity: rInspector, transform: `translateY(${(1 - rInspector) * 16}px)`, marginTop: 4 }}>
                        <InspectorCard title="Button · Inspector">
                          <div style={{ display: "flex", gap: 10 }}>
                            <Field label="Label" grow>
                              <TypeText text="Claim reward" start={tType} cps={16} />
                            </Field>
                            <Field label="Style">
                              <span style={{ color: COLORS.green, fontWeight: 700 }}>Success</span>
                            </Field>
                          </div>
                          {!resolved ? (
                            <div style={{ display: "flex", alignItems: "center", gap: 8, color: COLORS.warning, fontSize: 13, fontWeight: 600 }}>
                              <span style={{ width: 8, height: 8, borderRadius: 4, background: COLORS.warning }} />
                              A button needs a label — Discord rejects it empty.
                            </div>
                          ) : (
                            <div style={{ display: "flex", alignItems: "center", gap: 8, color: COLORS.green, fontSize: 13, fontWeight: 700 }}>
                              ✓ Within Discord's limits
                            </div>
                          )}
                        </InspectorCard>
                      </div>
                    )}
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
                            <DBtn
                              label={labelDone ? "Claim reward" : "…"}
                              kind="success"
                              emoji="🎁"
                              glow={frame > tResolve && frame < tResolve + 40}
                            />
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
            {/* the floating header issue pill (over the preview, clear of the bar) */}
            <div style={{ position: "absolute", top: 58, right: 30 }}>
              {resolved ? (
                <IssuePill count={0} ok reveal={okIn} />
              ) : (
                <IssuePill count={1} reveal={pillIn} />
              )}
            </div>
          </div>
          {/* inside the camera → the tip stays locked to the UI through pans/zooms */}
          {frame > d + 152 && frame < tResolve + 30 && <Cursor x={cur.x} y={cur.y} pressed={cur.pressed} />}
        </AbsoluteFill>
      </Camera>

      <Sequence from={tInspector} durationInFrames={10}>
        <Audio src={staticFile(CLICK)} volume={0.6} />
      </Sequence>

      {[tContainer, tSection, tGallery, tButtons, tSelect].map((t, i) => (
        <Sequence key={i} from={t} durationInFrames={14}>
          <Audio src={staticFile(POP)} volume={0.5} />
        </Sequence>
      ))}
      {new Array(7).fill(0).map((_, i) => (
        <Sequence key={`t${i}`} from={tType + i * 5} durationInFrames={5}>
          <Audio src={staticFile(TICK)} volume={0.4} />
        </Sequence>
      ))}
      <Sequence from={tResolve} durationInFrames={24}>
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
