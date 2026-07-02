import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame } from "remotion";
import { Background } from "../components/Background";
import { Camera, Shot } from "../components/Camera";
import { Caption } from "../components/Caption";
import { Cursor } from "../components/Cursor";
import { Icon } from "../components/Icon";
import { Mascot } from "../components/Mascot";
import { TreeRow } from "../components/AppUI";
import { DMsg, DContainer, DHeading, DBody, DBtn } from "../components/DiscordUI";
import { Chip, AvatarDot, AppBtn, TypeText, useSpr, cursorAt, Waypoint } from "../components/Bits";
import { CAST } from "../data";
import { voDelay, SCENES, CLICK, PING, POP } from "../timeline";
import { COLORS } from "../theme";
import { INTER } from "../fonts";

const VoiceIcon: React.FC<{ size?: number; color?: string }> = ({ size = 17, color = "#fff" }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round">
    <path d="M11 5.5L6.5 9H3.8v6h2.7L11 18.5z" fill={`${color}22`} />
    <path d="M15 9a4.2 4.2 0 0 1 0 6M17.7 6.8a8 8 0 0 1 0 10.4" />
  </svg>
);

/**
 * ACTIVITY — starts where it really starts: a voice channel. The DWEEB
 * Activity is launched from the call, the (deliberately simple) embedded
 * builder opens, presence rings light up the tree, two edits land at once,
 * and Post flips to Update.
 */
export const SceneActivity: React.FC = () => {
  const frame = useCurrentFrame();
  const d = voDelay("activity");

  const tLaunch = d + 100; // click Launch in the voice channel
  const tOpen = d + 114; // the builder opens
  const tPresence = d + 195; // "live presence" — rings pulse
  const tEditKai = d + 215; // "real-time co-editing" — Kai retitles
  const tEditAria = d + 230; // Aria's button lands
  const tPost = d + 256; // "one-click publish"
  const tPosted = tPost + 12; // flips to Update

  const openP = useSpr(tOpen, { damping: 16 });
  const opened = frame >= tOpen;
  const posted = frame > tPosted;
  const ariaBtn = useSpr(tEditAria, { damping: 13 });
  const postedIn = useSpr(tPosted, { damping: 14 });
  const kaiTitleDone = frame > tEditKai + 30;

  // Cursor lives only in the voice-channel phase: over to Launch, click, done.
  const waypoints: Waypoint[] = [
    { f: d + 20, x: 860, y: 620 },
    { f: tLaunch - 8, x: 1290, y: 880 },
    { f: tLaunch, x: 1290, y: 880, press: true },
    { f: tLaunch + 10, x: 1290, y: 880 },
  ];
  const cur = cursorAt(frame, waypoints);

  // Strictly ascending keyframes, every move ≥30 frames — close on each beat,
  // wide again at the end.
  const shots: Shot[] = [
    { f: 0, x: 960, y: 540, s: 1.02 },
    { f: tLaunch - 24, x: 1085, y: 770, s: 1.26 }, // onto the launcher card
    { f: tOpen, x: 1085, y: 770, s: 1.26 }, // hold through the click
    { f: tOpen + 30, x: 960, y: 540, s: 1.08 }, // the whole builder, briefly
    { f: tPresence + 10, x: 830, y: 430, s: 1.22 }, // close: presence rings + live edits
    { f: tEditAria, x: 830, y: 430, s: 1.22 }, // hold through both edits
    { f: tPost + 8, x: 1280, y: 260, s: 1.26 }, // slow glide up to the header publish
    { f: tPosted + 16, x: 1280, y: 260, s: 1.26 },
    { f: tPosted + 48, x: 960, y: 540, s: 1.05 }, // zoom out through the tail
  ];

  const participants = [CAST.aria, CAST.kai, CAST.mo];

  return (
    <AbsoluteFill>
      <Background glow="dual" />
      <Camera shots={shots}>
        <AbsoluteFill style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          {/* Discord window hosting the call, then the Activity */}
          <div
            style={{
              width: 1700,
              height: 950,
              display: "flex",
              background: COLORS.dBgPrimary,
              borderRadius: 16,
              overflow: "hidden",
              border: `1px solid ${COLORS.dBgTertiary}`,
              boxShadow: "0 40px 120px rgba(0,0,0,0.6)",
              fontFamily: INTER,
            }}
          >
            {/* slim sidebar with the voice channel */}
            <div style={{ width: 250, background: COLORS.dBgSecondary, flexShrink: 0, padding: "14px 8px" }}>
              <div style={{ padding: "0 8px 12px", fontWeight: 700, fontSize: 16, color: "#fff", borderBottom: `1px solid ${COLORS.dBgTertiary}`, marginBottom: 10 }}>
                Nebula Gaming
              </div>
              <div style={{ padding: "4px 8px", fontSize: 12, fontWeight: 800, color: COLORS.dTextMuted }}>VOICE</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 8px", borderRadius: 6, background: "#404249", color: "#fff", fontSize: 15, fontWeight: 650 }}>
                <VoiceIcon />
                Staff Lounge
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5, padding: "6px 4px 2px 30px" }}>
                {participants.map((u) => (
                  <div key={u.name} style={{ display: "flex", alignItems: "center", gap: 8, color: COLORS.dTextMuted, fontSize: 13.5 }}>
                    <AvatarDot name={u.name} color={u.color} size={22} />
                    {u.name}
                  </div>
                ))}
                {opened && (
                  <div
                    style={{
                      marginTop: 4,
                      opacity: openP,
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      background: `${COLORS.blurple}22`,
                      border: `1px solid ${COLORS.blurple}55`,
                      borderRadius: 8,
                      padding: "6px 9px",
                      color: COLORS.text,
                      fontSize: 12.5,
                      fontWeight: 700,
                    }}
                  >
                    <Mascot size={18} glow={false} look={false} />
                    Playing DWEEB
                  </div>
                )}
              </div>
            </div>

            {/* main column — the call, then the embedded builder */}
            <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
              {/* ── phase A: the voice call ─────────────────────────────── */}
              {openP < 0.98 && (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    flexDirection: "column",
                    opacity: 1 - openP,
                    transform: `scale(${1 - openP * 0.03})`,
                  }}
                >
                  <div style={{ height: 54, display: "flex", alignItems: "center", gap: 10, padding: "0 18px", borderBottom: `1px solid ${COLORS.dBgTertiary}`, color: "#fff", fontWeight: 700, fontSize: 16, flexShrink: 0 }}>
                    <VoiceIcon color={COLORS.dTextMuted} />
                    Staff Lounge
                  </div>

                  {/* participant tiles */}
                  <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 18 }}>
                    {participants.map((u) => (
                      <div
                        key={u.name}
                        style={{
                          width: 300,
                          height: 188,
                          borderRadius: 14,
                          background: COLORS.dBgSecondary,
                          border: `1px solid ${COLORS.dBgTertiary}`,
                          position: "relative",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <AvatarDot name={u.name} color={u.color} size={74} />
                        <div
                          style={{
                            position: "absolute",
                            left: 12,
                            bottom: 10,
                            background: "rgba(0,0,0,0.55)",
                            borderRadius: 7,
                            padding: "3px 10px",
                            color: "#fff",
                            fontSize: 13,
                            fontWeight: 700,
                          }}
                        >
                          {u.name}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* the DWEEB activity launcher */}
                  <div style={{ display: "flex", justifyContent: "center", paddingBottom: 26 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 16,
                        background: COLORS.dBgSecondary,
                        border: `1px solid ${COLORS.dBgTertiary}`,
                        borderRadius: 16,
                        padding: "16px 20px",
                        width: 560,
                        boxSizing: "border-box",
                        boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
                      }}
                    >
                      <div
                        style={{
                          width: 52,
                          height: 52,
                          borderRadius: 14,
                          background: COLORS.blurple,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          flexShrink: 0,
                        }}
                      >
                        <Mascot size={42} glow={false} look={false} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ color: "#fff", fontWeight: 800, fontSize: 17 }}>DWEEB</div>
                        <div style={{ color: COLORS.dTextMuted, fontSize: 13.5 }}>Build a message together — Activity</div>
                      </div>
                      <AppBtn kind="primary" icon="rocket" size="sm" glow={frame > tLaunch - 18 && frame < tOpen}>
                        Launch
                      </AppBtn>
                    </div>
                  </div>

                  {/* call controls (decorative) */}
                  <div style={{ display: "flex", justifyContent: "center", gap: 12, paddingBottom: 22 }}>
                    {["🎙️", "🎧", "🖥️"].map((e) => (
                      <div key={e} style={{ width: 44, height: 44, borderRadius: "50%", background: COLORS.dBgSecondary, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>
                        {e}
                      </div>
                    ))}
                    <div style={{ width: 44, height: 44, borderRadius: "50%", background: "#da373c", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <svg width={19} height={19} viewBox="0 0 24 24" fill="#fff">
                        <path d="M12 9c-4.2 0-7.6 1.4-9.7 3.6-.4.4-.4 1.1 0 1.5l1.8 1.8c.4.4 1 .4 1.4.1l2.3-1.7c.3-.2.4-.5.4-.8v-1.6c1.2-.4 2.5-.6 3.8-.6s2.6.2 3.8.6v1.6c0 .3.1.6.4.8l2.3 1.7c.4.3 1 .3 1.4-.1l1.8-1.8c.4-.4.4-1.1 0-1.5C19.6 10.4 16.2 9 12 9z" />
                      </svg>
                    </div>
                  </div>
                </div>
              )}

              {/* ── phase B: the embedded builder (kept deliberately simple) ── */}
              {openP > 0.02 && (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    flexDirection: "column",
                    opacity: openP,
                    transform: `translateY(${(1 - openP) * 24}px)`,
                  }}
                >
                  {/* activity header: brand · publish controls · live presence + invite
                      (posting target + Post live HERE, like the real activity) */}
                  <div style={{ height: 54, display: "flex", alignItems: "center", gap: 11, padding: "0 18px", borderBottom: `1px solid ${COLORS.dBgTertiary}`, flexShrink: 0 }}>
                    <Mascot size={26} glow={false} look={false} />
                    <span style={{ color: "#fff", fontWeight: 800, fontSize: 16 }}>DWEEB</span>
                    <span style={{ color: COLORS.dTextMuted, fontSize: 13.5 }}>Activity · Staff Lounge</span>
                    <div style={{ flex: 1 }} />
                    <Chip icon="hash" color={COLORS.blurple}>
                      posting to #events
                    </Chip>
                    {posted && (
                      <div style={{ opacity: postedIn, display: "flex", alignItems: "center", gap: 6, color: COLORS.green, fontWeight: 800, fontSize: 14 }}>
                        <Icon name="check" size={16} color={COLORS.green} />
                        Posted
                      </div>
                    )}
                    <div
                      style={{
                        background: COLORS.blurple,
                        color: "#fff",
                        fontWeight: 800,
                        fontSize: 14.5,
                        borderRadius: 9,
                        padding: "8px 19px",
                        boxShadow: frame > tPost - 14 && frame < tPost + 8 ? `0 0 26px ${COLORS.blurple}99` : "none",
                      }}
                    >
                      {posted ? "Update" : "Post"}
                    </div>
                    <div style={{ width: 1, height: 26, background: COLORS.dBgTertiary, margin: "0 3px" }} />
                    <div style={{ display: "flex", alignItems: "center" }}>
                      {participants.map((u, i) => (
                        <div key={u.name} style={{ marginLeft: i === 0 ? 0 : -9 }}>
                          <AvatarDot name={u.name} color={u.color} size={30} ring={frame > tPresence ? u.color : undefined} />
                        </div>
                      ))}
                      <div
                        style={{
                          marginLeft: 8,
                          width: 30,
                          height: 30,
                          borderRadius: "50%",
                          border: `1.5px dashed ${COLORS.dTextMuted}`,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <Icon name="plus" size={15} color={COLORS.dTextMuted} />
                      </div>
                    </div>
                  </div>

                  {/* builder body: tree + preview — no extra chrome */}
                  <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
                    <div style={{ width: 440, flexShrink: 0, borderRight: `1px solid ${COLORS.dBgTertiary}`, background: COLORS.bg, padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
                      <TreeRow icon="▤" label="Container" depth={0} />
                      <TreeRow
                        icon="◧"
                        label="Section — Community night"
                        depth={1}
                        sel={frame > tEditKai - 6}
                        presence={frame > tPresence ? [CAST.kai] : undefined}
                      />
                      <TreeRow icon="¶" label="Text" depth={2} presence={frame > tPresence + 10 ? [CAST.mo] : undefined} />
                      <TreeRow
                        icon="⬚"
                        label="Buttons Row"
                        depth={1}
                        presence={frame > tPresence + 5 ? [CAST.aria] : undefined}
                      />
                    </div>

                    <div style={{ flex: 1, minWidth: 0, padding: 22, display: "flex", flexDirection: "column", justifyContent: "center" }}>
                      <DMsg author="Nebula Events" mascot time={posted ? "Today at 9:41 AM" : "live preview"}>
                        <div style={{ maxWidth: 620 }}>
                          <DContainer accent="#eb459e">
                            <DHeading icon="sparkle" iconColor="#eb459e">
                              <span>
                                Community night
                                {!kaiTitleDone ? (
                                  <TypeText text=" — Friday!" start={tEditKai} cps={16} caretColor={CAST.kai.color} />
                                ) : (
                                  " — Friday!"
                                )}
                              </span>
                            </DHeading>
                            <DBody>Customs at 7, movie after. Bring a friend — winners get the ✨ role.</DBody>
                            <div style={{ display: "flex", gap: 9 }}>
                              <DBtn label="RSVP" kind="primary" emoji="🎟️" />
                              {ariaBtn > 0.03 && (
                                <div style={{ opacity: ariaBtn, transform: `scale(${0.86 + ariaBtn * 0.14})` }}>
                                  <DBtn label="Suggest a game" emoji="🎮" glow={frame < tEditAria + 30} />
                                </div>
                              )}
                            </div>
                          </DContainer>
                        </div>
                      </DMsg>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
          {/* inside the camera → the tip stays locked to the UI through pans/zooms */}
          {frame > d + 16 && frame < tOpen && <Cursor x={cur.x} y={cur.y} pressed={cur.pressed} />}
        </AbsoluteFill>
      </Camera>

      <Sequence from={tLaunch} durationInFrames={10}>
        <Audio src={staticFile(CLICK)} volume={0.7} />
      </Sequence>
      <Sequence from={tOpen} durationInFrames={12}>
        <Audio src={staticFile(POP)} volume={0.5} />
      </Sequence>
      <Sequence from={tPresence} durationInFrames={12}>
        <Audio src={staticFile(POP)} volume={0.45} />
      </Sequence>
      <Sequence from={tEditAria} durationInFrames={12}>
        <Audio src={staticFile(POP)} volume={0.4} />
      </Sequence>
      <Sequence from={tPost} durationInFrames={10}>
        <Audio src={staticFile(CLICK)} volume={0.75} />
      </Sequence>
      <Sequence from={tPosted + 4} durationInFrames={20}>
        <Audio src={staticFile(PING)} volume={0.7} />
      </Sequence>

      <Caption
        parts={["Build", { hl: "together" }, "— right inside Discord."]}
        delay={d + 20}
        out={SCENES.activity.durationInFrames - 26}
        accent={COLORS.green}
      />
    </AbsoluteFill>
  );
};
