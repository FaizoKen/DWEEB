import React from "react";
import {
  AbsoluteFill,
  Audio,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
  Easing,
} from "remotion";
import { Background } from "../components/Background";
import { Camera, Shot } from "../components/Camera";
import { Caption } from "../components/Caption";
import { Cursor } from "../components/Cursor";
import { Icon } from "../components/Icon";
import { COLORS } from "../theme";
import { INTER } from "../fonts";
import { CLICK, CHIME, TICK } from "../timeline";

const BOT_NAME = "YourBot";

// One continuous screen: the custom bot posts a message to a channel (vo4),
// then a member clicks a button on THAT SAME message and it works (vo5).
const CLICK_AT = 188;
const CARD = { x: 360, y: 168, w: 1200 };

// World coords (measured off the rendered layout) for aiming camera + cursor.
const BOT = { x: 402, y: 270 };
const BTN = { x: 500, y: 411 };

export const SceneChannel: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const inSpring = spring({ frame: frame - 2, fps, config: { damping: 18, mass: 0.8 } });
  const postBadge = spring({ frame: frame - 80, fps, config: { damping: 12 } });

  const cx = interpolate(frame, [CLICK_AT - 44, CLICK_AT], [980, BTN.x], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.quad) });
  const cy = interpolate(frame, [CLICK_AT - 44, CLICK_AT], [560, BTN.y], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.quad) });
  const pressed = frame >= CLICK_AT && frame < CLICK_AT + 8;
  const ripple = interpolate(frame, [CLICK_AT, CLICK_AT + 22], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const reply = spring({ frame: frame - CLICK_AT - 8, fps, config: { damping: 16, mass: 0.7 } });

  // Bot is customised live: the name types in, then the icon is set.
  const nameTyped = interpolate(frame, [22, 58], [0, BOT_NAME.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const nameDone = frame >= 59;
  const customized = frame >= 62;
  const iconPop = frame >= 62 && frame < 76 ? Math.sin(((frame - 62) / 14) * Math.PI) : 0;
  const nameCaret = Math.floor(frame / 8) % 2 === 0;

  // custom-bot callout (appears once the bot is named + has its icon)
  const callIn = spring({ frame: frame - 74, fps, config: { damping: 13, mass: 0.6 } });
  const callOut = interpolate(frame, [124, 138], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const callOpacity = callIn * callOut;
  const botGlow = 0.5 + 0.5 * Math.sin(frame / 7);

  // Camera: push in on the bot's identity → reframe to the channel header → ease
  // back for the whole message → track the cursor to the button and punch in on
  // the click + the reply that appears.
  const { width, height } = useVideoConfig();
  const vertical = height > width;

  const shotsH: Shot[] = [
    { f: 0, x: 960, y: 470, s: 0.92 },
    { f: 24, x: 900, y: 300, s: 1.12 },
    { f: 95, x: 960, y: 250, s: 1.06 },
    { f: 140, x: 940, y: 440, s: 1.06, ease: Easing.bezier(0.4, 0, 0.1, 1) },
    { f: CLICK_AT, x: 880, y: 440, s: 1.12 },
    { f: CLICK_AT + 26, x: 900, y: 480, s: 1.08 },
    { f: 259, x: 900, y: 480, s: 1.08 },
  ];
  // Portrait: the message card is ~1200 wide, so it fits the width nicely. Push
  // onto the bot identity, up to the channel header, back to the whole card,
  // then punch in on the button + the reply.
  const shotsV: Shot[] = [
    { f: 0, x: 860, y: 390, s: 0.84 },
    { f: 24, x: 640, y: 330, s: 1.1 },
    { f: 95, x: 720, y: 300, s: 1.02 },
    { f: 140, x: 780, y: 410, s: 0.98, ease: Easing.bezier(0.4, 0, 0.1, 1) },
    { f: CLICK_AT, x: 600, y: 440, s: 1.12 },
    { f: CLICK_AT + 26, x: 760, y: 500, s: 1.0 },
    { f: 259, x: 760, y: 500, s: 1.0 },
  ];
  const shots = vertical ? shotsV : shotsH;

  return (
    <AbsoluteFill>
      <Background glow="dual" />

      <Camera shots={shots} drift={2}>
        <div
          style={{
            position: "absolute",
            left: CARD.x,
            top: CARD.y,
            width: CARD.w,
            transform: `translateY(${interpolate(inSpring, [0, 1], [30, 0])}px)`,
            opacity: inSpring,
            background: COLORS.dBgPrimary,
            borderRadius: 16,
            border: `1px solid ${COLORS.dBgTertiary}`,
            overflow: "hidden",
            boxShadow: "0 30px 80px rgba(0,0,0,0.55)",
          }}
        >
          {/* channel header */}
          <div
            style={{
              height: 56,
              background: COLORS.dBgSecondary,
              borderBottom: `1px solid ${COLORS.dBgTertiary}`,
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "0 22px",
              fontFamily: INTER,
              fontWeight: 700,
              fontSize: 20,
              color: "#fff",
            }}
          >
            <span style={{ color: COLORS.dTextMuted, fontSize: 24 }}>#</span> announcements
            <span style={{ flex: 1 }} />
            <span
              style={{
                opacity: postBadge,
                transform: `scale(${interpolate(postBadge, [0, 1], [0.7, 1])})`,
                fontSize: 14,
                fontWeight: 700,
                color: COLORS.green,
                background: `${COLORS.green}1f`,
                border: `1px solid ${COLORS.green}55`,
                borderRadius: 8,
                padding: "5px 12px",
              }}
            >
              ✓ Posted
            </span>
          </div>

          {/* the message (posted by YourBot) */}
          <div style={{ padding: 24 }}>
            <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
              {/* avatar — starts as a default placeholder, then the custom
                  bot icon is set with a pop + a ring flash */}
              <div
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: "50%",
                  background: customized ? COLORS.green : COLORS.dButtonSecondary,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  position: "relative",
                  flexShrink: 0,
                  transform: `scale(${1 + iconPop * 0.18})`,
                  boxShadow: customized && callOpacity > 0.05 ? `0 0 ${10 + botGlow * 18}px ${COLORS.green}` : "none",
                }}
              >
                {customized ? (
                  <Icon name="bot" size={24} color="#06210f" />
                ) : (
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={COLORS.dTextMuted} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
                    <circle cx="8.5" cy="9.5" r="1.5" fill={COLORS.dTextMuted} stroke="none" />
                    <path d="M4 18l5-5 3.5 3 3-2 4.5 4" />
                  </svg>
                )}
                {frame >= 62 && frame < 86 && (
                  <div
                    style={{
                      position: "absolute",
                      inset: -3,
                      borderRadius: "50%",
                      border: `2px solid ${COLORS.green}`,
                      transform: `scale(${1 + ((frame - 62) / 24) * 0.6})`,
                      opacity: 1 - (frame - 62) / 24,
                    }}
                  />
                )}
              </div>

              {/* name — typed into an input, then settles as the author name */}
              {nameDone ? (
                <span style={{ color: "#fff", fontWeight: 700, fontSize: 17 }}>{BOT_NAME}</span>
              ) : (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    background: COLORS.bgInput,
                    border: `1px solid ${COLORS.borderStrong}`,
                    borderRadius: 6,
                    padding: "2px 8px",
                    color: "#fff",
                    fontFamily: INTER,
                    fontWeight: 700,
                    fontSize: 16,
                  }}
                >
                  {BOT_NAME.slice(0, Math.floor(nameTyped))}
                  <span style={{ display: "inline-block", width: 2, height: 18, marginLeft: 1, background: COLORS.green, opacity: nameCaret ? 1 : 0 }} />
                </span>
              )}
              <span style={{ opacity: customized ? 1 : 0, background: COLORS.green, color: "#06210f", fontSize: 11, fontWeight: 800, padding: "1px 5px", borderRadius: 4 }}>BOT</span>
              <span style={{ opacity: postBadge, color: COLORS.dTextMuted, fontSize: 13 }}>just now</span>

              <div
                style={{
                  opacity: callOpacity,
                  transform: `translateX(${interpolate(callIn, [0, 1], [-14, 0])}px)`,
                  marginLeft: 6,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  background: `${COLORS.green}1f`,
                  border: `1px solid ${COLORS.green}`,
                  color: COLORS.green,
                  fontFamily: INTER,
                  fontWeight: 800,
                  fontSize: 14,
                  borderRadius: 999,
                  padding: "5px 12px",
                }}
              >
                <Icon name="sparkle" size={15} color={COLORS.green} />
                your own custom bot
              </div>
            </div>

            <div style={{ display: "flex", gap: 14, background: COLORS.dBgSecondary, borderRadius: 10, padding: 16 }}>
              <div style={{ width: 4, borderRadius: 4, background: COLORS.green, flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div style={{ color: "#fff", fontFamily: INTER, fontWeight: 800, fontSize: 23, marginBottom: 6, display: "flex", alignItems: "center", gap: 8 }}>
                  <Icon name="rocket" size={24} color={COLORS.green} />
                  Season 4 is live
                </div>
                <div style={{ color: COLORS.dText, fontFamily: INTER, fontSize: 16, marginBottom: 16 }}>
                  New maps, ranked rewards, and a fresh battle pass. Claim your founder reward below.
                </div>
                <div style={{ display: "flex", gap: 12 }}>
                  <div style={{ position: "relative" }}>
                    <div
                      style={{
                        background: COLORS.dButtonSuccess,
                        color: "#fff",
                        fontFamily: INTER,
                        fontWeight: 700,
                        fontSize: 16,
                        padding: "11px 20px",
                        borderRadius: 8,
                        transform: `scale(${pressed ? 0.94 : 1})`,
                        boxShadow: pressed ? `0 0 22px ${COLORS.green}` : "none",
                        display: "flex",
                        alignItems: "center",
                        gap: 7,
                      }}
                    >
                      <Icon name="gift" size={18} color="#fff" />
                      Claim reward
                    </div>
                    {frame >= CLICK_AT && (
                      <div
                        style={{
                          position: "absolute",
                          inset: 0,
                          borderRadius: 8,
                          border: `2px solid ${COLORS.green}`,
                          transform: `scale(${1 + ripple * 0.5})`,
                          opacity: 1 - ripple,
                        }}
                      />
                    )}
                  </div>
                  <div style={{ background: COLORS.dButtonPrimary, color: "#fff", fontFamily: INTER, fontWeight: 700, fontSize: 16, padding: "11px 20px", borderRadius: 8, display: "flex", alignItems: "center", gap: 7 }}>
                    <Icon name="notes" size={18} color="#fff" />
                    Patch notes
                  </div>
                  <div style={{ background: COLORS.dButtonSecondary, color: "#fff", fontFamily: INTER, fontWeight: 700, fontSize: 16, padding: "11px 20px", borderRadius: 8, display: "flex", alignItems: "center", gap: 7 }}>
                    <Icon name="link" size={18} color="#fff" />
                    Invite
                  </div>
                </div>
              </div>
            </div>

            {/* ephemeral reply once clicked */}
            {frame > CLICK_AT + 6 && (
              <div
                style={{
                  marginTop: 16,
                  transform: `translateY(${interpolate(reply, [0, 1], [28, 0])}px)`,
                  opacity: reply,
                  background: COLORS.dBgSecondary,
                  border: `1px solid ${COLORS.green}55`,
                  borderRadius: 12,
                  padding: "14px 18px",
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                }}
              >
                <Icon name="check" size={26} color={COLORS.green} />
                <div>
                  <div style={{ fontFamily: INTER, fontWeight: 800, fontSize: 17, color: "#fff" }}>
                    It works! <span style={{ color: COLORS.green }}>instant response</span>
                  </div>
                  <div style={{ fontFamily: INTER, fontSize: 14, color: COLORS.dTextMuted }}>
                    Buttons can reply, give roles, open a form — whatever you set up.
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <Cursor x={cx} y={cy} pressed={pressed} />
      </Camera>

      {/* type ticks as the bot name is entered */}
      {[24, 30, 36, 42, 48, 54].map((f) => (
        <Sequence key={`t-${f}`} from={f} durationInFrames={6}>
          <Audio src={staticFile(TICK)} volume={0.4} />
        </Sequence>
      ))}
      <Sequence from={62} durationInFrames={10}>
        <Audio src={staticFile(CLICK)} volume={0.45} />
      </Sequence>

      <Sequence from={CLICK_AT} durationInFrames={12}>
        <Audio src={staticFile(CLICK)} volume={0.5} />
      </Sequence>
      <Sequence from={CLICK_AT + 8} durationInFrames={30}>
        <Audio src={staticFile(CHIME)} volume={0.5} />
      </Sequence>

      <Caption parts={["Posted by ", { hl: "your own bot" }, " — to any channel."]} delay={10} out={CLICK_AT - 30} accent={COLORS.green} />
      <Caption parts={["Buttons that ", { hl: "actually work" }, "."]} delay={CLICK_AT - 20} accent={COLORS.green} />
    </AbsoluteFill>
  );
};
