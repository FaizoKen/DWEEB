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
import { AppFrame } from "../components/AppFrame";
import { Caption } from "../components/Caption";
import { Cursor } from "../components/Cursor";
import { Icon } from "../components/Icon";
import { COLORS } from "../theme";
import { INTER } from "../fonts";
import { CLICK } from "../timeline";

const SELECT_AT = 150; // when the "Tickets" plugin gets chosen

// App + grid geometry in world space.
const APP = { x: 110, y: 90, w: 1700, h: 900 };
// Tickets tile (col 1, row 1) centre — derived from the layout below.
const TICKETS = { x: 410, y: 300 };

type P = { name: string; desc: string; icon: keyof typeof ICONS; accent: string; more?: boolean };

const PLUGINS: P[] = [
  { name: "Tickets", desc: "Private support threads", icon: "tag", accent: COLORS.warning },
  { name: "Giveaways", desc: "Button-entry draws", icon: "gift", accent: COLORS.green },
  { name: "Reaction roles", desc: "Roles from reactions", icon: "emoji", accent: COLORS.green },
  { name: "Self-roles", desc: "Click to get a role", icon: "grid", accent: COLORS.blurple },
  { name: "Verification", desc: "One-tap member verify", icon: "shield", accent: COLORS.green },
  { name: "Welcome", desc: "Greet every new member", icon: "wave", accent: COLORS.warning },
  { name: "Polls", desc: "Live vote tallies", icon: "bars", accent: COLORS.blurple },
  { name: "Suggestions", desc: "Collect & upvote ideas", icon: "bulb", accent: COLORS.warning },
  { name: "Applications", desc: "Staff & role forms", icon: "form", accent: COLORS.green },
  { name: "Quick replies", desc: "Canned button answers", icon: "chat", accent: COLORS.blurple },
  { name: "Announcements", desc: "Rich, pingable embeds", icon: "megaphone", accent: COLORS.blurple },
  { name: "…and many more", desc: "A growing library", icon: "plus", accent: COLORS.textSubtle, more: true },
];

export const ScenePlugins: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // cursor sweeps onto the Tickets tile and clicks it
  const cx = interpolate(frame, [20, SELECT_AT], [1380, TICKETS.x], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.quad) });
  const cy = interpolate(frame, [20, SELECT_AT], [840, TICKETS.y], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.quad) });
  const click = frame >= SELECT_AT - 3 && frame < SELECT_AT + 7;

  // Camera: establish the library → push toward Tickets as it's named → punch in
  // on the click → ease back out to reveal the whole library ("…and many more").
  const shots: Shot[] = [
    { f: 0, x: 960, y: 500, s: 0.93 },
    { f: 44, x: 820, y: 380, s: 1.08 },
    { f: SELECT_AT, x: 810, y: 350, s: 1.14 },
    { f: SELECT_AT + 32, x: 810, y: 350, s: 1.14 },
    { f: SELECT_AT + 80, x: 980, y: 540, s: 0.92, ease: Easing.bezier(0.4, 0, 0.1, 1) },
    { f: 260, x: 980, y: 540, s: 0.92 },
  ];

  return (
    <AbsoluteFill>
      <Background glow="blurple" />

      <Camera shots={shots} drift={2}>
        <div style={{ position: "absolute", left: APP.x, top: APP.y }}>
          <AppFrame width={APP.w} height={APP.h}>
            <div style={{ height: "100%", background: COLORS.bg, padding: 36, display: "flex", flexDirection: "column", gap: 22 }}>
              {/* header */}
              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <span style={{ fontFamily: INTER, fontWeight: 800, fontSize: 30, color: COLORS.text, display: "flex", alignItems: "center", gap: 12 }}>
                  <Icon name="blocks" size={28} color={COLORS.green} />
                  Plugin Library
                </span>
                <div style={{ flex: 1 }} />
                <div
                  style={{
                    width: 320,
                    height: 40,
                    background: COLORS.bgInput,
                    border: `1px solid ${COLORS.border}`,
                    borderRadius: 10,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "0 14px",
                    fontFamily: INTER,
                    fontSize: 15,
                    color: COLORS.textSubtle,
                  }}
                >
                  <Icon name="search" size={16} color={COLORS.textSubtle} />
                  Search plugins…
                </div>
              </div>

              {/* grid */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20 }}>
                {PLUGINS.map((p, i) => (
                  <PluginTile key={p.name} p={p} index={i} selected={frame >= SELECT_AT && i === 0} />
                ))}
              </div>
            </div>
          </AppFrame>
        </div>

        <Cursor x={cx} y={cy} pressed={click} />
      </Camera>

      <Sequence from={SELECT_AT} durationInFrames={12}>
        <Audio src={staticFile(CLICK)} volume={0.5} />
      </Sequence>

      <Caption parts={["A whole ", { hl: "library of plugins" }, " — one click."]} delay={10} accent={COLORS.blurple} />
    </AbsoluteFill>
  );
};

const PluginTile: React.FC<{ p: P; index: number; selected: boolean }> = ({ p, index, selected }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame: frame - 2 - index * 4, fps, config: { damping: 14, mass: 0.6, stiffness: 130 } });
  const selPop = spring({ frame: frame - SELECT_AT, fps, config: { damping: 12 } });

  return (
    <div
      style={{
        transform: `translateY(${interpolate(pop, [0, 1], [40, 0])}px) scale(${interpolate(pop, [0, 1], [0.85, 1]) * (selected ? 1 + selPop * 0.03 : 1)})`,
        opacity: pop * (p.more ? 0.85 : 1),
        background: p.more ? "transparent" : COLORS.bgElevated,
        border: `${selected ? 2 : 1}px ${p.more ? "dashed" : "solid"} ${selected ? COLORS.green : p.more ? COLORS.border : `${p.accent}3a`}`,
        borderRadius: 16,
        padding: "18px 18px",
        height: 132,
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        position: "relative",
        boxShadow: selected ? `0 0 28px ${COLORS.green}66` : "0 12px 30px rgba(0,0,0,0.35)",
      }}
    >
      {selected && (
        <span
          style={{
            position: "absolute",
            top: 12,
            right: 14,
            background: COLORS.green,
            color: "#06210f",
            fontFamily: INTER,
            fontWeight: 800,
            fontSize: 13,
            borderRadius: 7,
            padding: "3px 9px",
          }}
        >
          ✓ Added
        </span>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 13,
            background: p.more ? "transparent" : `${p.accent}22`,
            border: `1px solid ${p.accent}55`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          {ICONS[p.icon](p.accent)}
        </div>
        <span style={{ fontFamily: INTER, fontWeight: 800, fontSize: 21, color: COLORS.text }}>{p.name}</span>
      </div>
      <span style={{ fontFamily: INTER, fontSize: 15.5, color: COLORS.textSubtle }}>{p.desc}</span>
    </div>
  );
};

const ICONS = {
  tag: (c: string) => (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
      <path d="M3.2 11 L11 3.2 H18.8 a2 2 0 0 1 2 2 V13 L13 20.8 a2 2 0 0 1-2.9 0 L3.2 13.9 a2 2 0 0 1 0-2.9 Z" fill={`${c}22`} stroke={c} strokeWidth="1.8" strokeLinejoin="round" />
      <circle cx="16" cy="8" r="1.5" fill={c} />
    </svg>
  ),
  gift: (c: string) => (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
      <rect x="3.5" y="9" width="17" height="11.5" rx="2" fill={`${c}22`} stroke={c} strokeWidth="1.7" />
      <path d="M3.5 13 H20.5 M12 9 V20.5" stroke={c} strokeWidth="1.7" />
      <path d="M12 9 C9 9 7.5 4.6 10 4 C12 3.6 12 9 12 9 Z M12 9 C15 9 16.5 4.6 14 4 C12 3.6 12 9 12 9 Z" fill={c} />
    </svg>
  ),
  grid: (c: string) => (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
      {[[4, 4], [13, 4], [4, 13], [13, 13]].map(([x, y], i) => (
        <rect key={i} x={x} y={y} width="7" height="7" rx="2.2" fill={i === 3 ? c : `${c}33`} stroke={c} strokeWidth="1.5" />
      ))}
    </svg>
  ),
  chat: (c: string) => (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
      <path d="M4 5 h16 a2 2 0 0 1 2 2 v8 a2 2 0 0 1-2 2 H9 l-4 3 v-3 H4 a2 2 0 0 1-2-2 V7 a2 2 0 0 1 2-2 Z" fill={`${c}22`} stroke={c} strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M7 9.5 h10 M7 12.5 h6" stroke={c} strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  ),
  form: (c: string) => (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
      <rect x="4" y="3.5" width="16" height="17" rx="2.4" fill={`${c}22`} stroke={c} strokeWidth="1.7" />
      <path d="M8 8 h8 M8 12 h8 M8 16 h5" stroke={c} strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  ),
  star: (c: string) => (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
      <path d="M12 3 l2.6 5.5 6 .8 -4.4 4.2 1.1 6 -5.3-2.9 -5.3 2.9 1.1-6 -4.4-4.2 6-.8 Z" fill={`${c}33`} stroke={c} strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  ),
  bars: (c: string) => (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
      <rect x="4" y="11" width="4" height="8" rx="1.4" fill={c} />
      <rect x="10" y="7" width="4" height="12" rx="1.4" fill={c} />
      <rect x="16" y="4" width="4" height="15" rx="1.4" fill={`${c}88`} />
    </svg>
  ),
  emoji: (c: string) => (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="8.4" fill={`${c}22`} stroke={c} strokeWidth="1.7" />
      <circle cx="9.2" cy="10.5" r="1.3" fill={c} />
      <circle cx="14.8" cy="10.5" r="1.3" fill={c} />
      <path d="M8.6 14.5 a4 3 0 0 0 6.8 0" stroke={c} strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  ),
  plus: (c: string) => (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
      <path d="M12 5 v14 M5 12 h14" stroke={c} strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  ),
  shield: (c: string) => (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
      <path d="M12 3 l7 2.6 V11 c0 4.4-3 7.6-7 9 -4-1.4-7-4.6-7-9 V5.6 Z" fill={`${c}22`} stroke={c} strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M8.7 12 l2.2 2.2 4.2-4.4" stroke={c} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  wave: (c: string) => (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
      <circle cx="9.5" cy="8" r="3.2" fill={`${c}22`} stroke={c} strokeWidth="1.7" />
      <path d="M3.6 19 a6 6 0 0 1 11.8 0" stroke={c} strokeWidth="1.7" strokeLinecap="round" />
      <path d="M18.5 7.5 v5 M16 10 h5" stroke={c} strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  ),
  bulb: (c: string) => (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
      <path d="M12 3 a6 6 0 0 1 3.8 10.6 c-.6.5-.9 1.1-.9 1.9 H9.1 c0-.8-.3-1.4-.9-1.9 A6 6 0 0 1 12 3 Z" fill={`${c}22`} stroke={c} strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M9.6 18.5 h4.8 M10.4 21 h3.2" stroke={c} strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  ),
  megaphone: (c: string) => (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
      <path d="M4 10 v4 a1 1 0 0 0 1 1 h2 l9 4.5 V4.5 L7 9 H5 a1 1 0 0 0-1 1 Z" fill={`${c}22`} stroke={c} strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M19 9.5 a3 3 0 0 1 0 5" stroke={c} strokeWidth="1.7" strokeLinecap="round" />
      <path d="M7.5 15.5 V19 a1.5 1.5 0 0 0 3 0 v-2" stroke={c} strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  ),
};
