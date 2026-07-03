import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame } from "remotion";
import { Background } from "../components/Background";
import { Camera, Shot, useVertical } from "../components/Camera";
import { Caption } from "../components/Caption";
import { Cursor } from "../components/Cursor";
import { Icon } from "../components/Icon";
import { AppWindow, ActionBar, AppTabs, TreeRow } from "../components/AppUI";
import { DMsg, DContainer, DHeading, DBody, DGallery, DBtn, DSelect } from "../components/DiscordUI";
import { Chip, useSpr, cursorAt, Waypoint } from "../components/Bits";
import { PLUGINS } from "../data";
import { voDelay, seqFrom, SCENES, CLICK, TICK, POP, CHIME, WHOOSH } from "../timeline";
import { COLORS } from "../theme";
import { INTER } from "../fonts";

const PROMPT =
  "Write a Season 4 launch announcement with a media gallery and buttons for rewards and patch notes.";

/** One-line blurbs for the picker rows (the full cards live in registry.json). */
const SHORT: Record<string, string> = {
  tickets: "Private support tickets — claim, close, transcript",
  giveaway: "Button giveaways with a fair random draw",
  "self-role": "Members self-assign their own roles",
  "modal-form": "Pop-up form, answers land in a channel",
  "quick-replies": "Canned replies — private or public",
  picker: "User / role / channel select menus",
  "ping-pong": "Click → a detailed latency report",
};

/**
 * PLUGINS — continues the assistant's shot: the chat panel slides closed, the
 * flagged button is selected in the tree, and the "Attach a plugin" picker
 * opens right in the editor with all seven plugins. Giveaway is attached and
 * the chip lands on the button row.
 */
export const ScenePlugins: React.FC = () => {
  const frame = useCurrentFrame();
  const vert = useVertical();
  const d = voDelay("plugins");

  const tPanelOut = d + 10; // the AI chat slides closed — same take, next beat
  const tSel = d + 52; // "Select a button" — click the tree row
  const tDialog = d + 82; // "pick a plugin" — the picker opens
  const hl = [d + 140, d + 166, d + 190, d + 212]; // tickets → giveaway → role menus → pop-up forms
  const tPick = d + 236; // click Giveaway
  const tClose = d + 248; // picker closes
  const tAttach = d + 260; // chip lands on the button row

  const panelOut = useSpr(tPanelOut, { damping: 18 });
  const dialogIn = useSpr(tDialog, { damping: 15 });
  const dialogOut = useSpr(tClose, { damping: 18 });
  const attached = frame > tAttach;

  // Which picker cell the cursor is over (order: Tickets, Giveaway, Self Role,
  // Modal Form). After the pick, Giveaway stays lit.
  const hover =
    frame >= tPick - 10 ? 1 : frame >= hl[3] ? 3 : frame >= hl[2] ? 2 : frame >= hl[1] ? 1 : frame >= hl[0] ? 0 : -1;
  const hlOrder = ["tickets", "giveaway", "self-role", "modal-form"];

  // World-space picker cell centers (card centered in the window at (960, 540);
  // grid top ≈ 365, cell 84 high + 12 gap, two 450-wide columns).
  const cell = (i: number) => ({ x: i % 2 === 0 ? 729 : 1191, y: 407 + Math.floor(i / 2) * 104 });
  const waypoints: Waypoint[] = [
    { f: d + 6, x: 760, y: 800 },
    { f: tSel - 6, x: 350, y: 581 }, // "Button — Enter giveaway" row
    { f: tSel, x: 350, y: 581, press: true },
    { f: tSel + 20, x: 520, y: 590 },
    { f: hl[0], x: cell(0).x, y: cell(0).y },
    { f: hl[1], x: cell(1).x, y: cell(1).y },
    { f: hl[2], x: cell(2).x, y: cell(2).y },
    { f: hl[3], x: cell(3).x, y: cell(3).y },
    { f: tPick - 8, x: cell(1).x, y: cell(1).y },
    { f: tPick, x: cell(1).x, y: cell(1).y, press: true },
    { f: tPick + 12, x: cell(1).x, y: cell(1).y },
  ];
  const cur = cursorAt(frame, waypoints);

  // Opens on the assistant scene's final framing (continuous take), then close
  // in on each beat and pull wide once the chip lands. The camera HOLDS through
  // the 20-frame overlap — if it moved, the matched cut would ghost.
  const shots: Shot[] = vert
    ? [
        { f: 0, x: 1240, y: 490, s: 1.1 }, // == assistant's portrait final framing
        { f: 24, x: 1240, y: 490, s: 1.1 }, // hold: the AI chat slides off-frame
        { f: tSel - 12, x: 400, y: 530, s: 1.5 }, // onto the button row
        { f: tSel + 10, x: 400, y: 530, s: 1.5 },
        { f: tDialog + 16, x: 960, y: 540, s: 1.06 }, // the picker, edge to edge
        { f: tClose, x: 960, y: 540, s: 1.06 },
        { f: tClose + 30, x: 500, y: 555, s: 1.45 }, // the chip lands on the row
      ]
    : [
        { f: 0, x: 960, y: 535, s: 1.05 },
        { f: 24, x: 960, y: 535, s: 1.05 },
        { f: tSel - 12, x: 620, y: 520, s: 1.28 }, // onto the button row
        { f: tSel + 10, x: 620, y: 520, s: 1.28 },
        { f: tDialog + 16, x: 960, y: 535, s: 1.24 }, // the picker
        { f: tClose, x: 960, y: 535, s: 1.24 },
        // one slow settle toward the button row as the chip lands — wide enough to
        // read the whole editor, so no extra zoom-out is needed before the cut
        { f: tClose + 30, x: 760, y: 545, s: 1.18 },
      ];

  return (
    <AbsoluteFill>
      <Background glow="dual" />
      {/* drift phase = absolute start → handheld motion continuous across the
          matched cut from the assistant scene */}
      <Camera shots={shots} phase={seqFrom("plugins")}>
        <AbsoluteFill style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <AppWindow
            width={1760}
            height={950}
            leftWidth={560}
            left={
              <>
                <ActionBar />
                <AppTabs />
                <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1, minHeight: 0 }}>
                  <TreeRow icon="▤" label="Container" depth={0} />
                  <TreeRow icon="◧" label="Section" depth={1} />
                  <TreeRow icon="¶" label="Text" depth={2} />
                  <TreeRow icon="▦" label="Media Gallery" depth={1} />
                  <TreeRow icon="⬚" label="Buttons Row" depth={1} />
                  <TreeRow icon="▢" label="Button — Claim reward" depth={2} />
                  <TreeRow icon="▢" label="Button — Patch notes" depth={2} />
                  <TreeRow
                    icon="▢"
                    label="Button — Enter giveaway"
                    depth={2}
                    sel={frame > tSel}
                    chip={attached ? "Giveaway" : undefined}
                    chipColor="#f0b232"
                  />
                  <TreeRow icon="☰" label="String Select" depth={1} />
                </div>
              </>
            }
            right={
              <div
                style={{
                  width: "100%",
                  maxWidth: 640,
                  marginTop: 12,
                  transform: `translateX(${(1 - panelOut) * -210}px)`,
                }}
              >
                <DMsg author="Nebula Announcements" mascot>
                  <DContainer accent={COLORS.green}>
                    <DHeading icon="rocket">Season 4 is live</DHeading>
                    <DBody>
                      New maps, ranked rewards, and a fresh battle pass. Jump in and claim your
                      founder badge before the weekend.
                    </DBody>
                    {/* h matches the assistant scene's preview exactly — a 10px
                        difference here would ghost through the matched cut */}
                    <DGallery h={150} />
                    <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
                      <DBtn label="Claim reward" kind="success" emoji="🎁" />
                      <DBtn label="Patch notes" kind="primary" />
                      <DBtn label="Enter giveaway" emoji="🎉" glow={attached && frame < tAttach + 46} />
                    </div>
                    <DSelect placeholder="Choose your platform…" />
                  </DContainer>
                </DMsg>
              </div>
            }
            overlay={
              <>
                {/* the AI chat from the previous beat — slides closed, no cut */}
                {panelOut < 0.99 && (
                  <div
                    style={{
                      position: "absolute",
                      top: 44,
                      bottom: 0,
                      right: 0,
                      width: 430,
                      background: COLORS.bgElevated,
                      borderLeft: `1px solid ${COLORS.borderStrong}`,
                      boxShadow: "-24px 0 60px rgba(0,0,0,0.45)",
                      transform: `translateX(${panelOut * 460}px)`,
                      display: "flex",
                      flexDirection: "column",
                      fontFamily: INTER,
                    }}
                  >
                    <div
                      style={{
                        height: 52,
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "0 16px",
                        borderBottom: `1px solid ${COLORS.border}`,
                        flexShrink: 0,
                      }}
                    >
                      <Icon name="sparkle" size={19} color={COLORS.green} />
                      <span style={{ fontSize: 16, fontWeight: 800, color: COLORS.text }}>AI Assistant</span>
                      <div style={{ flex: 1 }} />
                      <span style={{ color: COLORS.textSubtle, fontSize: 17, fontWeight: 700 }}>✕</span>
                    </div>
                    <div style={{ flex: 1, minHeight: 0, padding: 16, display: "flex", flexDirection: "column", gap: 13 }}>
                      <div
                        style={{
                          alignSelf: "flex-end",
                          maxWidth: 340,
                          background: COLORS.blurple,
                          color: "#fff",
                          borderRadius: "14px 14px 4px 14px",
                          padding: "11px 14px",
                          fontSize: 14.5,
                          lineHeight: 1.45,
                        }}
                      >
                        {PROMPT}
                      </div>
                      <div
                        style={{
                          alignSelf: "flex-start",
                          maxWidth: 350,
                          background: COLORS.bgSubtle,
                          border: `1px solid ${COLORS.border}`,
                          borderRadius: "14px 14px 14px 4px",
                          padding: "12px 14px",
                          fontSize: 14.5,
                          lineHeight: 1.5,
                          color: COLORS.text,
                          display: "flex",
                          flexDirection: "column",
                          gap: 10,
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "flex-start", gap: 9 }}>
                          <Icon name="wand" size={18} color={COLORS.green} />
                          <span>Drafted — container, section, media gallery, and two buttons are in your editor.</span>
                        </div>
                        <Chip icon="check" color={COLORS.green}>
                          Applied to your message
                        </Chip>
                      </div>
                    </div>
                    <div style={{ padding: 14, borderTop: `1px solid ${COLORS.border}`, display: "flex", gap: 9, flexShrink: 0 }}>
                      <div
                        style={{
                          flex: 1,
                          background: COLORS.bgInput,
                          border: `1px solid ${COLORS.border}`,
                          borderRadius: 10,
                          padding: "10px 13px",
                          fontSize: 13.5,
                          color: COLORS.textSubtle,
                        }}
                      >
                        Describe the message you want…
                      </div>
                      <div
                        style={{
                          width: 40,
                          height: 40,
                          borderRadius: 10,
                          background: COLORS.blurple,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          flexShrink: 0,
                        }}
                      >
                        <Icon name="send" size={17} color="#fff" />
                      </div>
                    </div>
                  </div>
                )}

                {/* the "Attach a plugin" picker — all seven shipped plugins */}
                {dialogIn > 0.01 && dialogOut < 0.98 && (
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      background: `rgba(0,0,0,${0.45 * dialogIn * (1 - dialogOut)})`,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <div
                      style={{
                        width: 960,
                        background: COLORS.bgElevated,
                        border: `1px solid ${COLORS.borderStrong}`,
                        borderRadius: 18,
                        padding: 24,
                        boxShadow: "0 40px 120px rgba(0,0,0,0.65)",
                        fontFamily: INTER,
                        opacity: dialogIn * (1 - dialogOut),
                        transform: `translateY(${(1 - dialogIn) * 26 + dialogOut * -14}px) scale(${0.96 + dialogIn * 0.04 - dialogOut * 0.03})`,
                        display: "flex",
                        flexDirection: "column",
                        gap: 16,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <Icon name="plug" size={24} color={COLORS.green} />
                        <span style={{ fontSize: 21, fontWeight: 800, color: COLORS.text }}>Attach a plugin</span>
                        <span style={{ fontSize: 14, color: COLORS.textSubtle }}>
                          Button — Enter giveaway · configured visually, sandboxed
                        </span>
                      </div>
                      {/* minmax(0,…): a bare 1fr can't shrink below the cards'
                          nowrap descriptions, which made the left column wider */}
                      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 12 }}>
                        {PLUGINS.map((p) => {
                          const hlIdx = hlOrder.indexOf(p.id);
                          const lit = hlIdx !== -1 && hlIdx === hover;
                          const picked = p.id === "giveaway" && frame >= tPick;
                          return (
                            <div
                              key={p.id}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 12,
                                background: picked ? `${p.color}1c` : COLORS.bgSubtle,
                                border: `1.5px solid ${lit || picked ? p.color : COLORS.border}`,
                                boxShadow: lit || picked ? `0 0 26px ${p.color}44` : "none",
                                borderRadius: 12,
                                padding: "12px 14px",
                                height: 84,
                                boxSizing: "border-box",
                              }}
                            >
                              <div
                                style={{
                                  width: 42,
                                  height: 42,
                                  borderRadius: 11,
                                  background: `${p.color}22`,
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  flexShrink: 0,
                                }}
                              >
                                <Icon name={p.icon} size={23} color={p.color} />
                              </div>
                              <div style={{ minWidth: 0, flex: 1 }}>
                                <div style={{ fontSize: 16.5, fontWeight: 800, color: COLORS.text }}>{p.name}</div>
                                <div style={{ fontSize: 13, color: COLORS.textMuted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                  {SHORT[p.id]}
                                </div>
                              </div>
                              {picked ? (
                                <div style={{ display: "flex", alignItems: "center", gap: 6, color: COLORS.green, fontSize: 13.5, fontWeight: 800 }}>
                                  <Icon name="check" size={16} color={COLORS.green} />
                                  Attach
                                </div>
                              ) : (
                                <span
                                  style={{
                                    fontSize: 11.5,
                                    fontWeight: 700,
                                    color: COLORS.textMuted,
                                    background: COLORS.bgInput,
                                    border: `1px solid ${COLORS.border}`,
                                    padding: "3px 9px",
                                    borderRadius: 999,
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {p.targets}
                                </span>
                              )}
                            </div>
                          );
                        })}
                        {/* 8th cell — evens out the 7-plugin grid into 2×4 */}
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            gap: 9,
                            border: `1.5px dashed ${COLORS.border}`,
                            borderRadius: 12,
                            height: 84,
                            boxSizing: "border-box",
                            color: COLORS.textMuted,
                            fontSize: 13.5,
                            fontWeight: 700,
                          }}
                        >
                          <Icon name="sparkle" size={17} color={COLORS.textMuted} />
                          {PLUGINS.reduce((n, p) => n + p.presets, 0)} ready-made presets included
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </>
            }
          />
          {/* inside the camera → the tip stays locked to the UI through pans/zooms */}
          {frame > d && frame < tClose + 10 && <Cursor x={cur.x} y={cur.y} pressed={cur.pressed} />}
        </AbsoluteFill>
      </Camera>

      <Sequence from={tPanelOut} durationInFrames={14}>
        <Audio src={staticFile(WHOOSH)} volume={0.2} />
      </Sequence>
      <Sequence from={tSel} durationInFrames={10}>
        <Audio src={staticFile(CLICK)} volume={0.65} />
      </Sequence>
      <Sequence from={tDialog} durationInFrames={12}>
        <Audio src={staticFile(POP)} volume={0.5} />
      </Sequence>
      {hl.map((t, i) => (
        <Sequence key={i} from={t} durationInFrames={6}>
          <Audio src={staticFile(TICK)} volume={0.42} />
        </Sequence>
      ))}
      <Sequence from={tPick} durationInFrames={10}>
        <Audio src={staticFile(CLICK)} volume={0.75} />
      </Sequence>
      <Sequence from={tAttach} durationInFrames={22}>
        <Audio src={staticFile(CHIME)} volume={0.55} />
      </Sequence>

      <Caption
        parts={["Select a button —", { hl: "give it real behavior." }]}
        delay={d + 18}
        out={SCENES.plugins.durationInFrames - 26}
        accent={COLORS.green}
      />
    </AbsoluteFill>
  );
};
