import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame } from "remotion";
import { Background } from "../components/Background";
import { Camera, Shot, useVertical } from "../components/Camera";
import { Caption } from "../components/Caption";
import { Cursor } from "../components/Cursor";
import { Icon } from "../components/Icon";
import { AppWindow, ActionBar, AppTabs } from "../components/AppUI";
import {
  AssistantDock,
  CAMPAIGN_PROMPT,
  CampaignPreview,
  CampaignTree,
} from "../components/CampaignUI";
import { useSpr, cursorAt, Waypoint } from "../components/Bits";
import { PLUGINS } from "../data";
import { voDelay, seqFrom, SCENES, CLICK, TICK, POP, CHIME, WHOOSH } from "../timeline";
import { COLORS } from "../theme";
import { INTER } from "../fonts";

const FEATURED_IDS = ["giveaway", "tickets", "self-role", "modal-form"];
const FEATURED = FEATURED_IDS.map((id) => PLUGINS.find((plugin) => plugin.id === id)).filter(
  (plugin): plugin is (typeof PLUGINS)[number] => plugin !== undefined,
);

const SHORT: Record<string, string> = {
  giveaway: "Fair draws, live entrant count, rerolls",
  tickets: "Private support channels with transcripts",
  "self-role": "Roles members can choose themselves",
  "modal-form": "Collect answers in a pop-up form",
};

/**
 * The AI-added button becomes a real Giveaway. This scene only ATTACHES the
 * plugin — the button is clicked for real in the next scene, after the message
 * has landed in Discord, which is where a button click actually means something.
 */
export const ScenePlugins: React.FC = () => {
  const frame = useCurrentFrame();
  const vert = useVertical();
  const d = voDelay("plugins");

  const tPanelOut = d + 4;
  const tSelect = d + 32;
  const tDialog = d + 58;
  const tHighlight = d + 88;
  const tPick = d + 118;
  const tClose = d + 132;
  const tAttach = d + 146;

  const panelOut = useSpr(tPanelOut, { damping: 20, stiffness: 150 });
  const dialogIn = useSpr(tDialog, { damping: 17, stiffness: 150 });
  const dialogOut = useSpr(tClose, { damping: 20, stiffness: 160 });
  const attached = frame >= tAttach;

  const giveawayCell = vert ? { x: 960, y: 400 } : { x: 738, y: 490 };
  // Dwell at each target, then hop in a short confident move — never a crawl.
  const waypoints: Waypoint[] = [
    { f: d + 2, x: 1160, y: 720 },
    { f: tSelect - 22, x: 1160, y: 720 },
    { f: tSelect - 4, x: 360, y: 606 },
    { f: tSelect, x: 360, y: 606, press: true },
    { f: tDialog + 6, x: 360, y: 606 },
    { f: tDialog + 22, x: giveawayCell.x, y: giveawayCell.y },
    { f: tPick, x: giveawayCell.x, y: giveawayCell.y, press: true },
    { f: tClose + 6, x: giveawayCell.x, y: giveawayCell.y },
    { f: tClose + 22, x: 880, y: 600 },
  ];
  const cursor = cursorAt(frame, waypoints);

  // First keyframe continues the assistant scene's final framing; after the
  // attach beat the camera pushes on the now-live button, then hands the exact
  // send-scene framing across the hold cut.
  const shots: Shot[] = vert
    ? [
        { f: 16, x: 1215, y: 470, s: 1.48 },
        { f: tSelect, x: 390, y: 525, s: 1.68 },
        { f: tDialog + 18, x: 960, y: 540, s: 1.48 },
        { f: tClose, x: 960, y: 540, s: 1.48 },
        { f: tAttach + 20, x: 1240, y: 500, s: 1.6 },
        { f: tAttach + 36, x: 1240, y: 500, s: 1.6 },
        { f: SCENES.plugins.durationInFrames + 10, x: 430, y: 400, s: 1.68 },
      ]
    : [
        { f: 16, x: 1000, y: 500, s: 1.08 },
        { f: tSelect, x: 720, y: 510, s: 1.16 },
        { f: tDialog + 18, x: 960, y: 520, s: 1.18 },
        { f: tClose, x: 960, y: 520, s: 1.18 },
        { f: tAttach + 20, x: 1180, y: 520, s: 1.36 },
        { f: tAttach + 44, x: 1180, y: 520, s: 1.36 },
        { f: SCENES.plugins.durationInFrames + 10, x: 830, y: 465, s: 1.12 },
      ];

  const dialogVisible = dialogIn > 0.01 && dialogOut < 0.99;

  return (
    <AbsoluteFill>
      <Background glow="dual" />
      <Camera shots={shots} phase={seqFrom("plugins")}>
        <AbsoluteFill style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <AppWindow
            width={1680}
            height={900}
            leftWidth={520}
            left={
              <>
                <ActionBar />
                <AppTabs />
                <CampaignTree selectedGiveaway={frame >= tSelect} attached={attached} />
              </>
            }
            right={
              <div
                style={{
                  width: "100%",
                  display: "flex",
                  justifyContent: "center",
                  marginTop: 18,
                  transform: `translateX(${-190 * (1 - panelOut)}px)`,
                }}
              >
                <CampaignPreview giveawayGlow={attached && frame < tAttach + 44} scale={0.98} />
              </div>
            }
            overlay={
              <>
                {panelOut < 0.999 && (
                  <AssistantDock reveal={1 - panelOut} prompt={CAMPAIGN_PROMPT} status="done" />
                )}

                {dialogVisible && (
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      background: `rgba(4,5,8,${0.66 * dialogIn * (1 - dialogOut)})`,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      zIndex: 20,
                    }}
                  >
                    <div
                      style={{
                        width: vert ? 700 : 940,
                        padding: vert ? 24 : 26,
                        borderRadius: 22,
                        background: "linear-gradient(145deg, #1a1d24, #12151b)",
                        border: `1px solid ${COLORS.borderStrong}`,
                        boxShadow: "0 45px 130px rgba(0,0,0,.72)",
                        opacity: dialogIn * (1 - dialogOut),
                        transform: `translateY(${(1 - dialogIn) * 24 - dialogOut * 14}px) scale(${0.96 + dialogIn * 0.04 - dialogOut * 0.025})`,
                        fontFamily: INTER,
                      }}
                    >
                      <div
                        style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}
                      >
                        <div
                          style={{
                            width: 40,
                            height: 40,
                            borderRadius: 12,
                            background: `${COLORS.green}18`,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <Icon name="plug" size={22} color={COLORS.green} />
                        </div>
                        <div>
                          <div style={{ color: COLORS.text, fontWeight: 850, fontSize: 21 }}>
                            Make this button work
                          </div>
                          <div style={{ color: COLORS.textSubtle, fontSize: 13.5, marginTop: 2 }}>
                            Button · Enter giveaway
                          </div>
                        </div>
                      </div>

                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: vert ? "1fr" : "1fr 1fr",
                          gap: 12,
                        }}
                      >
                        {FEATURED.map((plugin, i) => {
                          const selected = plugin.id === "giveaway" && frame >= tHighlight;
                          return (
                            <div
                              key={plugin.id}
                              style={{
                                minHeight: vert ? 88 : 112,
                                display: "flex",
                                alignItems: "center",
                                gap: 13,
                                padding: vert ? "12px 15px" : "15px 16px",
                                borderRadius: 14,
                                background: selected ? `${plugin.color}1c` : COLORS.bgSubtle,
                                border: `1.5px solid ${selected ? plugin.color : COLORS.border}`,
                                boxShadow: selected ? `0 0 34px ${plugin.color}3d` : "none",
                                transform: `translateY(${Math.max(0, 1 - dialogIn) * (12 + i * 3)}px)`,
                              }}
                            >
                              <div
                                style={{
                                  width: 44,
                                  height: 44,
                                  borderRadius: 12,
                                  flexShrink: 0,
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  background: `${plugin.color}22`,
                                }}
                              >
                                <Icon name={plugin.icon} size={24} color={plugin.color} />
                              </div>
                              <div style={{ minWidth: 0, flex: 1 }}>
                                <div style={{ color: COLORS.text, fontWeight: 820, fontSize: 17 }}>
                                  {plugin.name}
                                </div>
                                <div
                                  style={{
                                    color: COLORS.textMuted,
                                    fontSize: 13,
                                    marginTop: 3,
                                    lineHeight: 1.3,
                                  }}
                                >
                                  {SHORT[plugin.id]}
                                </div>
                              </div>
                              {selected && <Icon name="check" size={20} color={COLORS.green} />}
                            </div>
                          );
                        })}
                      </div>
                      <div
                        style={{
                          marginTop: 13,
                          color: COLORS.textSubtle,
                          fontSize: 13,
                          textAlign: "center",
                          fontWeight: 700,
                        }}
                      >
                        +{PLUGINS.length - FEATURED.length} more visual plugins
                      </div>
                    </div>
                  </div>
                )}
              </>
            }
          />

          {frame >= d && frame < tAttach + 12 && (
            <Cursor x={cursor.x} y={cursor.y} pressed={cursor.pressed} size={30} />
          )}
        </AbsoluteFill>
      </Camera>

      <Sequence from={tPanelOut} durationInFrames={14}>
        <Audio src={staticFile(WHOOSH)} volume={0.18} />
      </Sequence>
      <Sequence from={tSelect} durationInFrames={10}>
        <Audio src={staticFile(CLICK)} volume={0.62} />
      </Sequence>
      <Sequence from={tDialog} durationInFrames={12}>
        <Audio src={staticFile(POP)} volume={0.5} />
      </Sequence>
      <Sequence from={tHighlight} durationInFrames={7}>
        <Audio src={staticFile(TICK)} volume={0.38} />
      </Sequence>
      <Sequence from={tPick} durationInFrames={10}>
        <Audio src={staticFile(CLICK)} volume={0.72} />
      </Sequence>
      <Sequence from={tAttach} durationInFrames={22}>
        <Audio src={staticFile(CHIME)} volume={0.54} />
      </Sequence>

      <Caption
        label="Visual plugins"
        parts={["Buttons that", { hl: "actually work." }]}
        delay={d + 8}
        out={SCENES.plugins.durationInFrames - 16}
        accent={COLORS.green}
      />
    </AbsoluteFill>
  );
};
