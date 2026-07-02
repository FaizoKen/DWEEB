import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame, interpolate } from "remotion";
import { Background } from "../components/Background";
import { Camera, Shot } from "../components/Camera";
import { Caption } from "../components/Caption";
import { AppWindow, ActionBar, AppTabs, TreeRow, AddComponentBtn } from "../components/AppUI";
import { DMsg, DContainer, DHeading, DBody, DGallery, DBtn } from "../components/DiscordUI";
import { Icon } from "../components/Icon";
import { TypeText, Chip, useSpr } from "../components/Bits";
import { voDelay, seqFrom, SCENES, POP, TICK, CHIME } from "../timeline";
import { COLORS } from "../theme";
import { INTER } from "../fonts";

const PROMPT =
  "Write a Season 4 launch announcement with a media gallery and buttons for rewards and patch notes.";

/** Pulsing "thinking" dots while the assistant works. */
const Thinking: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <div style={{ display: "flex", gap: 6, padding: "4px 2px" }}>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            width: 9,
            height: 9,
            borderRadius: "50%",
            background: COLORS.textMuted,
            opacity: 0.35 + 0.65 * Math.abs(Math.sin((frame - i * 5) / 9)),
          }}
        />
      ))}
    </div>
  );
};

/**
 * ASSISTANT — the built-in AI assistant, docked to the far right of the editor
 * exactly like the real app's panel. Type a prompt, the draft lands in the
 * tree AND the preview at once. No model names, no provider chips — just
 * "describe it, get a message".
 */
export const SceneAssistant: React.FC = () => {
  const frame = useCurrentFrame();
  const d = voDelay("assistant");

  const tPanel = d + 14; // panel slides in
  const tPrompt = d + 36; // typing starts
  const tThink = d + 116; // assistant "thinking"
  const tDraft = d + 148; // "…drafts the whole message" — the draft lands

  const panelIn = useSpr(tPanel, { damping: 17 });
  const replyIn = useSpr(tDraft, { damping: 14 });
  const thinking = frame >= tThink && frame < tDraft;
  const drafted = frame >= tDraft;

  const r = (at: number) => useSpr(at, { damping: 15, stiffness: 140 });
  const rows = [
    { icon: "▤", label: "Container", depth: 0, p: r(tDraft) },
    { icon: "◧", label: "Section", depth: 1, p: r(tDraft + 4) },
    { icon: "¶", label: "Text", depth: 2, p: r(tDraft + 8) },
    { icon: "▦", label: "Media Gallery", depth: 1, p: r(tDraft + 12) },
    { icon: "⬚", label: "Buttons Row", depth: 1, p: r(tDraft + 16) },
    { icon: "▢", label: "Button — Claim reward", depth: 2, p: r(tDraft + 20) },
    { icon: "▢", label: "Button — Patch notes", depth: 2, p: r(tDraft + 24) },
  ];

  // Close on the panel while the prompt types, then ONE slow 40-frame glide
  // out as the draft lands — tree and preview enter the frame as it widens.
  // The final framing matches the plugins scene's first shot AND is reached
  // before the scenes start overlapping, so the cut reads as one continuous
  // take where the chat simply closes.
  const shots: Shot[] = [
    { f: 0, x: 960, y: 540, s: 1.02 },
    { f: tPanel + 26, x: 1130, y: 440, s: 1.3 }, // close-up: the prompt types
    { f: tDraft + 2, x: 1130, y: 440, s: 1.3 },
    { f: tDraft + 42, x: 960, y: 535, s: 1.05 }, // slow zoom out, settled pre-cut
  ];

  return (
    <AbsoluteFill>
      <Background glow="dual" />
      {/* drift phase = absolute start, so the handheld motion carries straight
          through the matched cut into the plugins scene */}
      <Camera shots={shots} phase={seqFrom("assistant")}>
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
                  {!drafted && (
                    <div
                      style={{
                        border: `1.5px dashed ${COLORS.border}`,
                        borderRadius: 12,
                        padding: "26px 16px",
                        textAlign: "center",
                        fontFamily: INTER,
                        fontSize: 14,
                        color: COLORS.textSubtle,
                      }}
                    >
                      Your message is empty — describe it →
                    </div>
                  )}
                  {rows.map((row) => (
                    <TreeRow key={row.label} icon={row.icon} label={row.label} depth={row.depth} reveal={row.p} />
                  ))}
                  <div style={{ marginTop: "auto" }}>
                    <AddComponentBtn />
                  </div>
                </div>
              </>
            }
            right={
              /* the docked panel takes the right 430px — keep the preview
                 centered in the space that remains */
              <div style={{ width: "100%", maxWidth: 640, marginTop: 12, transform: `translateX(${panelIn * -210}px)` }}>
                {!drafted ? (
                  <div
                    style={{
                      border: `1.5px dashed ${COLORS.dDivider}`,
                      borderRadius: 12,
                      padding: "40px 20px",
                      textAlign: "center",
                      fontFamily: INTER,
                      fontSize: 14.5,
                      color: COLORS.dTextMuted,
                    }}
                  >
                    Nothing to preview yet
                  </div>
                ) : (
                  <DMsg author="Nebula Announcements" mascot>
                    <div style={{ opacity: rows[0].p }}>
                      <DContainer accent={COLORS.green}>
                        <div style={{ opacity: rows[1].p }}>
                          <DHeading icon="rocket">Season 4 is live</DHeading>
                        </div>
                        <div style={{ opacity: rows[2].p }}>
                          <DBody>
                            New maps, ranked rewards, and a fresh battle pass. Jump in and claim
                            your founder badge before the weekend.
                          </DBody>
                        </div>
                        <div style={{ opacity: rows[3].p, transform: `translateY(${(1 - rows[3].p) * 14}px)` }}>
                          <DGallery h={150} />
                        </div>
                        <div style={{ display: "flex", gap: 9, opacity: rows[5].p }}>
                          <DBtn label="Claim reward" kind="success" emoji="🎁" glow={frame < tDraft + 46} />
                          <DBtn label="Patch notes" kind="primary" />
                        </div>
                      </DContainer>
                    </div>
                  </DMsg>
                )}
              </div>
            }
            overlay={
              /* the AI assistant — docked to the far right, like the real app */
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
                  transform: `translateX(${(1 - panelIn) * 450}px)`,
                  display: "flex",
                  flexDirection: "column",
                  fontFamily: INTER,
                }}
              >
                {/* header */}
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

                {/* transcript */}
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
                      opacity: frame >= tPrompt - 4 ? 1 : 0,
                    }}
                  >
                    <TypeText text={PROMPT} start={tPrompt} cps={40} caretColor="#fff" />
                  </div>

                  {thinking && (
                    <div
                      style={{
                        alignSelf: "flex-start",
                        background: COLORS.bgSubtle,
                        border: `1px solid ${COLORS.border}`,
                        borderRadius: "14px 14px 14px 4px",
                        padding: "10px 14px",
                      }}
                    >
                      <Thinking />
                    </div>
                  )}

                  {drafted && (
                    <div
                      style={{
                        alignSelf: "flex-start",
                        maxWidth: 350,
                        opacity: replyIn,
                        transform: `translateY(${(1 - replyIn) * 14}px)`,
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
                  )}
                </div>

                {/* composer */}
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
            }
          />
        </AbsoluteFill>
      </Camera>

      <Sequence from={tPanel} durationInFrames={12}>
        <Audio src={staticFile(POP)} volume={0.5} />
      </Sequence>
      {new Array(11).fill(0).map((_, i) => (
        <Sequence key={i} from={tPrompt + 4 + i * 6} durationInFrames={5}>
          <Audio src={staticFile(TICK)} volume={0.3} />
        </Sequence>
      ))}
      <Sequence from={tDraft} durationInFrames={22}>
        <Audio src={staticFile(CHIME)} volume={0.5} />
      </Sequence>
      {[0, 8, 16].map((off) => (
        <Sequence key={`b${off}`} from={tDraft + off} durationInFrames={10}>
          <Audio src={staticFile(POP)} volume={0.3} />
        </Sequence>
      ))}

      <Caption
        parts={["Describe it —", { hl: "the assistant drafts it." }]}
        delay={d + 18}
        out={SCENES.assistant.durationInFrames - 26}
        accent="#9b84ee"
      />
    </AbsoluteFill>
  );
};
