import React from "react";
import { Img, staticFile } from "remotion";
import { COLORS } from "../../theme";
import { INTER } from "../../fonts";
import { withAlpha } from "../../lib/color";
import { Icon } from "../../components/Icon";
import { Mascot } from "../../components/Mascot";
import { NebulaIcon, PIcon, PORTRAIT_STAGE, PORTRAIT_UI, UserAvatar } from "../../components/editor";
import { DT } from "../../components/DiscordUI";
import { CAST, SERVER, VOICE, type CastMember } from "../../story/campaign";

/**
 * The voice call the Build Together coda opens in, and the Discord surfaces
 * that start the DWEEB Activity from it: the desktop client in the staff's
 * voice channel (call tiles, the call's control bar, the channel's member list
 * and the "Voice Connected" panel), the Activities shelf the call's rocket
 * button opens, and the launch splash Discord shows while an Activity loads
 * (the Activity's own background + cover art, public/activity-assets/). The
 * mobile client gets the same three states in the portrait box.
 *
 * Discord's chrome is stylised the way DiscordShell stylises it for the send
 * scene (same rail, sidebar metrics and palette) so the two read as one
 * client. Every size is in world px, and the geometry helpers below hand the
 * scene the same numbers the renderer uses, for cursor aims and framing.
 */

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Discord's call palette (dark theme). */
const D = {
  stage: "#000000",
  tile: "#1e1f22",
  panel: "#232428",
  control: "#2b2d31",
  controlLit: "#3f4147",
  text: "#dbdee1",
  muted: "#949ba4",
  green: "#23a559",
  red: "#da373c",
  tooltip: "#111214",
} as const;

/* ── Discord's call glyphs (24-unit grid, the film's line style) ────────── */

type Glyph = "speaker" | "mic" | "micOff" | "headphones" | "video" | "screen" | "hangup" | "signal" | "chat" | "rocket";

export const DGlyph: React.FC<{ name: Glyph; size: number; color?: string }> = ({ name, size, color = "currentColor" }) => {
  if (name === "rocket") return <Icon name="rocket" size={size} color={color} />;
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none" as const,
    stroke: color,
    strokeWidth: 1.9,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    style: { flexShrink: 0, display: "block" as const },
  };
  switch (name) {
    case "speaker":
      return (
        <svg {...common}>
          <path d="M11 5 6.5 9H3.5v6h3L11 19Z" fill={color} />
          <path d="M15.3 9a4.2 4.2 0 0 1 0 6M18 6.4a8 8 0 0 1 0 11.2" />
        </svg>
      );
    case "mic":
      return (
        <svg {...common}>
          <rect x="9" y="3" width="6" height="11" rx="3" fill={color} />
          <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
        </svg>
      );
    case "micOff":
      return (
        <svg {...common}>
          <rect x="9" y="3" width="6" height="11" rx="3" fill={color} />
          <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M4 4l16 16" />
        </svg>
      );
    case "headphones":
      return (
        <svg {...common}>
          <path d="M4 16v-3.5a8 8 0 0 1 16 0V16" />
          <rect x="3.5" y="14" width="4" height="6.5" rx="1.6" fill={color} />
          <rect x="16.5" y="14" width="4" height="6.5" rx="1.6" fill={color} />
        </svg>
      );
    case "video":
      return (
        <svg {...common}>
          <rect x="2.8" y="6.5" width="12.5" height="11" rx="2.4" fill={color} />
          <path d="M15.3 10.3 21 7.2v9.6l-5.7-3.1Z" fill={color} />
        </svg>
      );
    case "screen":
      return (
        <svg {...common}>
          <rect x="2.8" y="4" width="18.4" height="12.6" rx="2.2" />
          <path d="M8.5 20.2h7M12 16.6v3.6M12 13.2V7.6M9.4 10.2 12 7.6l2.6 2.6" />
        </svg>
      );
    case "hangup":
      return (
        <svg {...common} stroke="none">
          <path
            d="M2.6 13.2c5.2-4.6 13.6-4.6 18.8 0 .6.5.6 1.4.1 2l-1.5 1.7c-.5.5-1.2.6-1.8.3l-2.6-1.3c-.5-.3-.8-.8-.7-1.4l.3-1.7a11.4 11.4 0 0 0-6.4 0l.3 1.7c.1.6-.2 1.1-.7 1.4l-2.6 1.3c-.6.3-1.3.2-1.8-.3L2.5 15.2c-.5-.6-.5-1.5.1-2Z"
            fill={color}
          />
        </svg>
      );
    case "signal":
      return (
        <svg {...common} strokeWidth={2.4}>
          <path d="M5 19v-3M10 19v-6.5M15 19V9.5M20 19V6" />
        </svg>
      );
    case "chat":
      return (
        <svg {...common}>
          <path d="M4.2 5.2h15.6v10.6H9.8L4.2 20Z" />
        </svg>
      );
  }
};

/* ── Desktop geometry (world px) ─────────────────────────────────────────── */

/** The Discord window: the editor act's 1680 × 900 footprint, so the coda frames like the rest of the film. */
export const VOICE_L = { x: 120, y: 90, w: 1680, h: 900 } as const;
const RAIL = 74;
const SIDEBAR = 250;
const HEADER = 52;
/** The call stage: the main column under the channel header. */
export const STAGE_L = (() => {
  const x = VOICE_L.x + 1 + RAIL + SIDEBAR;
  const y = VOICE_L.y + 1 + HEADER;
  return { x, y, w: VOICE_L.x + VOICE_L.w - 1 - x, h: VOICE_L.y + VOICE_L.h - 1 - y };
})();
const STAGE_CX = STAGE_L.x + STAGE_L.w / 2;

/** Call tiles before the launch: a 2 × 2 grid over the controls band. */
const TILE_GAP = 16;
const CONTROLS_BAND = 88;
const TILE_W = (STAGE_L.w - 3 * TILE_GAP) / 2;
const TILE_H = (STAGE_L.h - TILE_GAP - CONTROLS_BAND - TILE_GAP) / 2;
const tileRect = (i: number) => ({
  x: STAGE_L.x + TILE_GAP + (i % 2) * (TILE_W + TILE_GAP),
  y: STAGE_L.y + TILE_GAP + Math.floor(i / 2) * (TILE_H + TILE_GAP),
  w: TILE_W,
  h: TILE_H,
});

/** The call's control bar: camera, screen, Activities (rocket), mic, and the red leave pill. */
const CTRL = { size: 56, hangupW: 72, gap: 12 } as const;
const CTRL_ITEMS = ["video", "screen", "rocket", "mic", "hangup"] as const;
type CtrlId = (typeof CTRL_ITEMS)[number];
const CTRL_ROW_W = CTRL.size * 4 + CTRL.hangupW + CTRL.gap * 4;
const CTRL_CY = STAGE_L.y + STAGE_L.h - CONTROLS_BAND / 2;
const ctrlCenter = (id: CtrlId) => {
  let x = STAGE_CX - CTRL_ROW_W / 2;
  for (const item of CTRL_ITEMS) {
    const w = item === "hangup" ? CTRL.hangupW : CTRL.size;
    if (item === id) return { x: x + w / 2, y: CTRL_CY };
    x += w + CTRL.gap;
  }
  throw new Error(`no control ${id}`);
};

/** The Activities popover, anchored above the rocket button. */
const SHELF_W = 600;
const SHELF_PAD = 16;
const SHELF_HEAD = 58;
const COVER_W = SHELF_W - 2 * SHELF_PAD;
const COVER_H = Math.round((COVER_W * 9) / 16);
const CARD_META = 60;
const SHELF_H = SHELF_PAD + SHELF_HEAD + COVER_H + CARD_META + SHELF_PAD;
export const SHELF_L = (() => {
  const rocket = ctrlCenter("rocket");
  const bottom = rocket.y - CTRL.size / 2 - 10;
  return { x: rocket.x - SHELF_W / 2, y: bottom - SHELF_H, w: SHELF_W, h: SHELF_H };
})();

/**
 * Where the Activity runs once launched: the call's focused tile, the stage
 * less a 16 px margin, over a strip of the call's participants. The DWEEB
 * Activity lays out inside it at 1000 CSS px wide (two columns, above the
 * product's 900 px breakpoint) — so its zoom is the tile's width / 1000.
 */
const ACT_MARGIN = 16;
const ACT_TOP = 12;
const ACT_H = 700;
export const ACT_RECT_L = {
  x: STAGE_L.x + ACT_MARGIN,
  y: STAGE_L.y + ACT_TOP,
  w: STAGE_L.w - 2 * ACT_MARGIN,
  h: ACT_H,
} as const;
/** The participant strip under the running Activity. */
const STRIP = { w: 150, h: 84, gap: 10 } as const;
export const STRIP_L = (() => {
  const n = VOICE.members.length;
  const w = n * STRIP.w + (n - 1) * STRIP.gap;
  return { x: STAGE_CX - w / 2, y: ACT_RECT_L.y + ACT_RECT_L.h + 12, w, h: STRIP.h };
})();

/** World-px aims for the pointer, from the renderer's own numbers. */
export const VOICE_AIMS_L = {
  rocket: ctrlCenter("rocket"),
  /** The DWEEB cover in the shelf (its visual centre). */
  dweeb: { x: SHELF_L.x + SHELF_W / 2, y: SHELF_L.y + SHELF_PAD + SHELF_HEAD + COVER_H / 2 },
  /** Somewhere calm over the call to fade the pointer in. */
  rest: { x: STAGE_CX + 40, y: STAGE_L.y + 330 },
};

/* ── Shared bits ──────────────────────────────────────────────────────────── */

/** A member's avatar with Discord's green speaking ring. */
const CallAvatar: React.FC<{ person: CastMember; size: number; speaking?: number; ring?: string }> = ({
  person,
  size,
  speaking = 0,
  ring = D.tile,
}) => {
  const s = clamp01(speaking);
  return (
    <div
      style={{
        borderRadius: "50%",
        boxShadow:
          s > 0.01
            ? `0 0 0 ${Math.max(2, size * 0.05)}px ${ring}, 0 0 0 ${Math.max(3.5, size * 0.085)}px ${withAlpha(D.green, s)}`
            : undefined,
      }}
    >
      <UserAvatar person={person} size={size} />
    </div>
  );
};

/** The Activity badge Discord puts on a member who is in an Activity (a small rocket). */
const ActivityBadge: React.FC<{ size: number; pop?: number }> = ({ size, pop = 1 }) => {
  const p = clamp01(pop);
  if (p <= 0.001) return null;
  return (
    <span
      style={{
        display: "inline-flex",
        opacity: Math.min(1, p * 1.6),
        transform: p < 1 ? `scale(${0.5 + 0.5 * p})` : undefined,
      }}
    >
      <DGlyph name="rocket" size={size} color={D.green} />
    </span>
  );
};

/* ── Desktop: the Discord window in the voice channel ─────────────────── */

export type CallState = {
  /** 0..1 speaking level per member name. */
  speaking?: Record<string, number>;
  /** 0..1 the Activity badge per member name (in the Activity). */
  inActivity?: Record<string, number>;
  /** 0..1 visibility of the pre-launch call view (tiles + controls). */
  call?: number;
  /** The control under the pointer / being pressed. */
  hover?: CtrlId | null;
  pressed?: CtrlId | null;
  /** 0..1 the rocket's "Start an Activity" tooltip. */
  tooltip?: number;
  /** 0..1 the participant strip under the running Activity. */
  strip?: number;
};

export const VoiceWindowL: React.FC<CallState> = (state) => (
  <div
    style={{
      position: "absolute",
      left: VOICE_L.x,
      top: VOICE_L.y,
      width: VOICE_L.w,
      height: VOICE_L.h,
      boxSizing: "border-box",
      display: "flex",
      background: DT.canvas,
      borderRadius: 16,
      overflow: "hidden",
      border: `1px solid ${COLORS.dBgTertiary}`,
      boxShadow: "0 40px 120px rgba(0,0,0,0.6)",
      fontFamily: INTER,
    }}
  >
    <Rail />
    <Sidebar {...state} />
    <div style={{ width: STAGE_L.w, flexShrink: 0, display: "flex", flexDirection: "column" }}>
      <div
        style={{
          height: HEADER,
          boxSizing: "border-box",
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "0 18px",
          borderBottom: `1px solid ${COLORS.dBgTertiary}`,
          background: DT.canvas,
          color: "#fff",
          fontWeight: 700,
          fontSize: 16.5,
        }}
      >
        <DGlyph name="speaker" size={21} color={DT.muted} />
        {VOICE.channel}
        <span style={{ flex: 1 }} />
        <DGlyph name="chat" size={22} color={DT.muted} />
        <PIcon name="users" size={22} color={DT.muted} />
      </div>
      <div style={{ position: "relative", flex: 1, background: D.stage, overflow: "hidden" }}>
        <CallStageL {...state} />
      </div>
    </div>
  </div>
);

/** The server rail, as DiscordShell draws it (Nebula selected). */
const Rail: React.FC = () => (
  <div
    style={{
      width: RAIL,
      flexShrink: 0,
      background: DT.rail,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      padding: "14px 0",
      gap: 10,
    }}
  >
    <div
      style={{
        width: 48,
        height: 48,
        borderRadius: 16,
        background: DT.canvas,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: DT.muted,
      }}
    >
      <PIcon name="forum" size={24} />
    </div>
    <div style={{ width: 32, height: 2, background: DT.divider, borderRadius: 1 }} />
    <div style={{ position: "relative" }}>
      <div style={{ position: "absolute", left: -13, top: 8, width: 4, height: 32, borderRadius: "0 4px 4px 0", background: "#fff" }} />
      <NebulaIcon size={48} shape="rounded" />
    </div>
    {["#23a559", "#f0b232", "#eb459e"].map((c, i) => (
      <div
        key={i}
        style={{
          width: 48,
          height: 48,
          borderRadius: 24,
          background: DT.canvas,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: c,
          fontWeight: 700,
          fontSize: 16,
        }}
      >
        {["GN", "SQ", "VX"][i]}
      </div>
    ))}
  </div>
);

const ChannelRow: React.FC<{ name: string; voice?: boolean; active?: boolean }> = ({ name, voice = false, active = false }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: "7px 8px",
      borderRadius: 6,
      background: active ? "rgba(151,151,159,0.24)" : "transparent",
      color: active ? "#fff" : COLORS.dChannel,
      fontWeight: active ? 600 : 500,
      fontSize: 15.5,
    }}
  >
    {voice ? (
      <DGlyph name="speaker" size={18} color={active ? "#fff" : COLORS.dChannel} />
    ) : (
      <PIcon name="hash" size={18} color={COLORS.dChannel} strokeWidth={2} />
    )}
    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
  </div>
);

const Category: React.FC<{ label: string }> = ({ label }) => (
  <div style={{ padding: "10px 8px 4px", fontSize: 12, fontWeight: 700, letterSpacing: "0.02em", color: DT.muted }}>{label}</div>
);

/** The channel list, the call's members under its voice channel, and the two bottom panels. */
const Sidebar: React.FC<CallState> = ({ speaking = {}, inActivity = {} }) => (
  <div style={{ width: SIDEBAR, flexShrink: 0, background: DT.sidebar, display: "flex", flexDirection: "column" }}>
    <div
      style={{
        height: HEADER,
        boxSizing: "border-box",
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 16px",
        fontWeight: 700,
        fontSize: 16.5,
        color: "#fff",
        borderBottom: `1px solid ${COLORS.dBgTertiary}`,
      }}
    >
      {SERVER.name}
      <PIcon name="chevronDown" size={16} color={DT.muted} />
    </div>
    <div style={{ flex: 1, padding: "12px 8px", display: "flex", flexDirection: "column", gap: 2 }}>
      <Category label="TEXT CHANNELS" />
      {SERVER.channels.map((c) => (
        <ChannelRow key={c} name={c} />
      ))}
      <Category label="VOICE CHANNELS" />
      <ChannelRow name={VOICE.channel} voice active />
      <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "2px 0 4px 34px" }}>
        {VOICE.members.map((m) => (
          <div key={m.name} style={{ display: "flex", alignItems: "center", gap: 8, height: 28, paddingRight: 8 }}>
            <CallAvatar person={m} size={22} speaking={speaking[m.name] ?? 0} ring={DT.sidebar} />
            <span style={{ color: D.text, fontSize: 14.5, fontWeight: 500 }}>{m.name}</span>
            <span style={{ flex: 1 }} />
            <ActivityBadge size={17} pop={inActivity[m.name] ?? 0} />
            {VOICE.muted.includes(m.name) && <DGlyph name="micOff" size={16} color={D.muted} />}
          </div>
        ))}
      </div>
      <ChannelRow name="Squad Up" voice />
    </div>
    {/* Voice Connected + the user panel (Discord's bottom-left pair). */}
    <div style={{ background: D.panel, flexShrink: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 12px 8px",
          borderBottom: `1px solid ${withAlpha("#ffffff", 0.06)}`,
        }}
      >
        <DGlyph name="signal" size={18} color={D.green} />
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
          <span style={{ color: D.green, fontSize: 14, fontWeight: 700 }}>Voice Connected</span>
          <span style={{ color: D.muted, fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {VOICE.channel} / {SERVER.name}
          </span>
        </div>
        <DGlyph name="hangup" size={20} color={D.text} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 10px 10px" }}>
        <div style={{ position: "relative" }}>
          <UserAvatar person={CAST.aria} size={32} />
          <span
            style={{
              position: "absolute",
              right: -2,
              bottom: -2,
              width: 12,
              height: 12,
              borderRadius: "50%",
              background: D.green,
              border: `3px solid ${D.panel}`,
            }}
          />
        </div>
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
          <span style={{ color: "#fff", fontSize: 14, fontWeight: 600 }}>{CAST.aria.name}</span>
          <span style={{ color: D.muted, fontSize: 12 }}>Online</span>
        </div>
        <DGlyph name="mic" size={19} color={D.text} />
        <DGlyph name="headphones" size={19} color={D.text} />
        <PIcon name="settings" size={19} color={D.text} />
      </div>
    </div>
  </div>
);

/** The call stage: the members' tiles + the control bar, then (after the launch) the participant strip. */
const CallStageL: React.FC<CallState> = ({ speaking = {}, call = 1, hover = null, pressed = null, tooltip = 0, strip = 0 }) => {
  const ox = STAGE_L.x;
  const oy = STAGE_L.y;
  return (
    <>
      {call > 0.001 && (
        <div style={{ position: "absolute", inset: 0, opacity: call < 1 ? call : undefined }}>
          {VOICE.members.map((m, i) => {
            const r = tileRect(i);
            return (
              <CallTile
                key={m.name}
                person={m}
                speaking={speaking[m.name] ?? 0}
                muted={VOICE.muted.includes(m.name)}
                style={{ left: r.x - ox, top: r.y - oy, width: r.w, height: r.h }}
                avatar={116}
                label={15}
              />
            );
          })}
          <div
            style={{
              position: "absolute",
              left: STAGE_CX - CTRL_ROW_W / 2 - ox,
              top: CTRL_CY - CTRL.size / 2 - oy,
              display: "flex",
              gap: CTRL.gap,
            }}
          >
            {CTRL_ITEMS.map((id) => (
              <CallControl key={id} id={id} size={CTRL.size} width={id === "hangup" ? CTRL.hangupW : CTRL.size} hover={hover === id} pressed={pressed === id} />
            ))}
          </div>
          <CallTooltip
            text="Start an Activity"
            reveal={tooltip}
            anchor={{ x: ctrlCenter("rocket").x - ox, y: CTRL_CY - CTRL.size / 2 - 10 - oy }}
          />
        </div>
      )}
      {strip > 0.001 && (
        <div
          style={{
            position: "absolute",
            left: STRIP_L.x - ox,
            top: STRIP_L.y - oy,
            display: "flex",
            gap: STRIP.gap,
            opacity: Math.min(1, strip * 1.4),
            transform: strip < 1 ? `translateY(${(1 - strip) * 18}px)` : undefined,
          }}
        >
          {VOICE.members.map((m) => (
            <CallTile
              key={m.name}
              person={m}
              speaking={speaking[m.name] ?? 0}
              muted={VOICE.muted.includes(m.name)}
              style={{ position: "relative", width: STRIP.w, height: STRIP.h }}
              avatar={40}
              label={11.5}
            />
          ))}
        </div>
      )}
    </>
  );
};

/** One member's call tile: their colour, avatar, speaking ring and name tag. */
const CallTile: React.FC<{
  person: CastMember;
  speaking: number;
  muted: boolean;
  style: React.CSSProperties;
  avatar: number;
  label: number;
}> = ({ person, speaking, muted, style, avatar, label }) => {
  const s = clamp01(speaking);
  return (
    <div
      style={{
        position: "absolute",
        boxSizing: "border-box",
        borderRadius: 10,
        overflow: "hidden",
        // A dark tile with a wash of the member's colour (Discord's call tiles
        // take theirs from the profile) — enough to tell four people apart.
        background: `radial-gradient(120% 120% at 50% 42%, ${withAlpha(person.color, 0.2)}, ${withAlpha(person.color, 0.06)} 62%), ${D.tile}`,
        boxShadow: s > 0.01 ? `inset 0 0 0 3px ${withAlpha(D.green, s)}` : undefined,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        ...style,
      }}
    >
      <CallAvatar person={person} size={avatar} speaking={s} ring={withAlpha("#000000", 0.35)} />
      <span
        style={{
          position: "absolute",
          left: label * 0.8,
          bottom: label * 0.8,
          display: "inline-flex",
          alignItems: "center",
          gap: label * 0.35,
          padding: `${label * 0.28}px ${label * 0.55}px`,
          borderRadius: label * 0.4,
          background: "rgba(0,0,0,0.55)",
          color: "#fff",
          fontWeight: 600,
          fontSize: label,
          lineHeight: 1.2,
        }}
      >
        {muted && <DGlyph name="micOff" size={label * 1.1} color={D.red} />}
        {person.name}
      </span>
    </div>
  );
};

const CallControl: React.FC<{ id: CtrlId; size: number; width: number; hover: boolean; pressed: boolean }> = ({
  id,
  size,
  width,
  hover,
  pressed,
}) => {
  const hang = id === "hangup";
  return (
    <div
      style={{
        width,
        height: size,
        borderRadius: size / 2,
        background: hang ? D.red : hover || pressed ? D.controlLit : D.control,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transform: pressed ? "scale(0.94)" : undefined,
        boxShadow: "0 4px 14px rgba(0,0,0,0.45)",
      }}
    >
      <DGlyph name={id} size={size * (id === "rocket" ? 0.56 : 0.46)} color="#fff" />
    </div>
  );
};

/** Discord's black tooltip with its downward caret, bottom-centred on `anchor`. */
const CallTooltip: React.FC<{ text: string; reveal: number; anchor: { x: number; y: number } }> = ({ text, reveal, anchor }) => {
  const r = clamp01(reveal);
  if (r <= 0.001) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: anchor.x,
        top: anchor.y,
        transform: `translate(-50%, -100%) translateY(${(1 - r) * 6}px)`,
        opacity: r,
        padding: "8px 12px",
        borderRadius: 7,
        background: D.tooltip,
        color: "#fff",
        fontSize: 15,
        fontWeight: 600,
        whiteSpace: "nowrap",
        boxShadow: "0 8px 22px rgba(0,0,0,0.5)",
      }}
    >
      {text}
      <span
        style={{
          position: "absolute",
          left: "50%",
          bottom: -6,
          marginLeft: -6,
          borderLeft: "6px solid transparent",
          borderRight: "6px solid transparent",
          borderTop: `6px solid ${D.tooltip}`,
        }}
      />
    </div>
  );
};

/* ── The Activities shelf ─────────────────────────────────────────────────── */

/** DWEEB's card in the shelf: the Activity's own cover art, its icon, name and line. */
const DweebCard: React.FC<{ width: number; hover: boolean; pressed: boolean; scale?: number }> = ({ width, hover, pressed, scale = 1 }) => {
  const h = Math.round((width * 9) / 16);
  return (
    <div
      style={{
        width,
        transform: pressed ? "scale(0.985)" : hover ? "scale(1.012)" : undefined,
        transformOrigin: "center",
      }}
    >
      <div
        style={{
          position: "relative",
          width,
          height: h,
          borderRadius: 10 * scale,
          overflow: "hidden",
          boxShadow: hover || pressed ? `0 0 0 ${2.5 * scale}px ${COLORS.blurple}, 0 10px 30px rgba(0,0,0,0.5)` : "0 6px 20px rgba(0,0,0,0.4)",
        }}
      >
        <Img src={staticFile("activity/cover.jpg")} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 * scale, paddingTop: 12 * scale }}>
        <div style={{ width: 38 * scale, height: 38 * scale, borderRadius: 10 * scale, overflow: "hidden", flexShrink: 0 }}>
          <Mascot size={38 * scale} glow={false} look={false} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span style={{ color: "#fff", fontSize: 17 * scale, fontWeight: 700 }}>DWEEB</span>
          <span style={{ color: D.muted, fontSize: 13.5 * scale }}>Build Discord messages together</span>
        </div>
      </div>
    </div>
  );
};

/** Desktop: the popover the call's rocket button opens. */
export const ActivityShelfL: React.FC<{ reveal: number; hover: boolean; pressed: boolean }> = ({ reveal, hover, pressed }) => {
  const r = clamp01(reveal);
  if (r <= 0.001) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: SHELF_L.x,
        top: SHELF_L.y,
        width: SHELF_L.w,
        height: SHELF_L.h,
        boxSizing: "border-box",
        padding: SHELF_PAD,
        borderRadius: 14,
        background: DT.sidebar,
        border: `1px solid ${withAlpha("#ffffff", 0.08)}`,
        boxShadow: "0 24px 70px rgba(0,0,0,0.65)",
        fontFamily: INTER,
        opacity: Math.min(1, r * 1.5),
        transform: `translateY(${(1 - r) * 16}px) scale(${0.96 + 0.04 * r})`,
        transformOrigin: "50% 100%",
      }}
    >
      <div style={{ height: SHELF_HEAD, display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <span style={{ color: "#fff", fontSize: 20, fontWeight: 700 }}>Activities</span>
          <span style={{ display: "flex", alignItems: "center", gap: 5, color: D.muted, fontSize: 13.5 }}>
            Start one in <DGlyph name="speaker" size={14} color={D.muted} /> {VOICE.channel}
          </span>
        </div>
        <PIcon name="close" size={20} color={D.muted} />
      </div>
      <DweebCard width={COVER_W} hover={hover} pressed={pressed} />
    </div>
  );
};

/* ── The launch splash (Discord's loading screen for an Activity) ─────────── */

/**
 * While an Activity loads, Discord shows the app's background art with its
 * icon and name. `progress` fills the loading bar.
 */
export const LaunchSplash: React.FC<{
  rect: { x: number; y: number; w: number; h: number };
  opacity: number;
  progress: number;
  /** 0..1 the icon, name and bar (they leave first; the art stays under the arriving app). */
  content?: number;
  radius?: number;
  scale?: number;
}> = ({ rect, opacity, progress, content = 1, radius = 8, scale = 1 }) => {
  if (opacity <= 0.001) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        borderRadius: radius,
        overflow: "hidden",
        opacity,
        fontFamily: INTER,
        background: "#0b0c12",
      }}
    >
      <Img src={staticFile("activity/background.jpg")} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(60% 60% at 50% 50%, rgba(8,9,14,0.2), rgba(8,9,14,0.65))" }} />
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16 * scale,
          opacity: content < 1 ? Math.max(0, content) : undefined,
        }}
      >
        <div style={{ width: 104 * scale, height: 104 * scale, borderRadius: 28 * scale, overflow: "hidden", boxShadow: "0 16px 50px rgba(88,101,242,0.45)" }}>
          <Mascot size={104 * scale} glow={false} look={false} />
        </div>
        <span style={{ color: "#fff", fontSize: 26 * scale, fontWeight: 800, letterSpacing: "0.01em" }}>DWEEB</span>
        <div style={{ width: 170 * scale, height: 5 * scale, borderRadius: 3 * scale, background: "rgba(255,255,255,0.14)", overflow: "hidden" }}>
          <div style={{ width: `${clamp01(progress) * 100}%`, height: "100%", borderRadius: 3 * scale, background: COLORS.blurple }} />
        </div>
      </div>
    </div>
  );
};

/* ── Portrait: Discord mobile in the call ─────────────────────────────────── */

/** The portrait box every coda surface shares (the Activity's own box, layout.tsx). */
export const BOX_V = {
  x: PORTRAIT_STAGE.x + PORTRAIT_UI.side,
  y: PORTRAIT_STAGE.y + PORTRAIT_UI.top,
  w: PORTRAIT_STAGE.w - 2 * PORTRAIT_UI.side,
  h: PORTRAIT_UI.bottom - PORTRAIT_UI.top,
} as const;

const M_HEADER = 60;
const M_TILE_GAP = 8;
const M_SIDE = 10;
const M_TILE_W = (BOX_V.w - 2 * M_SIDE - M_TILE_GAP) / 2;
const M_TILE_H = 250;
const M_TILES_TOP = M_HEADER + 10;
const M_SHEET_TOP = 598;
const M_CTRL = { size: 58, gap: 14 } as const;
const M_CTRL_ITEMS = ["video", "mic", "rocket", "speaker", "hangup"] as const;
type MCtrlId = (typeof M_CTRL_ITEMS)[number];
const M_CTRL_CY = M_SHEET_TOP + 70;
const mCtrlCenter = (id: MCtrlId) => {
  const rowW = M_CTRL_ITEMS.length * M_CTRL.size + (M_CTRL_ITEMS.length - 1) * M_CTRL.gap;
  const i = M_CTRL_ITEMS.indexOf(id);
  return { x: BOX_V.x + (BOX_V.w - rowW) / 2 + i * (M_CTRL.size + M_CTRL.gap) + M_CTRL.size / 2, y: BOX_V.y + M_CTRL_CY };
};

/** The mobile Activities sheet (box units): its top, the cover's box. */
const MS_TOP = 214;
const MS_PAD = 16;
const MS_HEAD = 74;
const MS_COVER_W = BOX_V.w - 2 * MS_PAD;
const MS_COVER_H = Math.round((MS_COVER_W * 9) / 16);

export const VOICE_AIMS_V = {
  rocket: mCtrlCenter("rocket"),
  dweeb: { x: BOX_V.x + BOX_V.w / 2, y: BOX_V.y + MS_TOP + MS_PAD + MS_HEAD + MS_COVER_H / 2 },
};

export const VoiceCallV: React.FC<{
  speaking?: Record<string, number>;
  hover?: MCtrlId | null;
  pressed?: MCtrlId | null;
  /** 0..1 the Activities sheet (with its scrim over the call). */
  sheet?: number;
  dweebHover?: boolean;
  dweebPressed?: boolean;
  opacity?: number;
}> = ({ speaking = {}, hover = null, pressed = null, sheet = 0, dweebHover = false, dweebPressed = false, opacity = 1 }) => {
  if (opacity <= 0.001) return null;
  const sh = clamp01(sheet);
  return (
    <div
      style={{
        position: "absolute",
        left: BOX_V.x,
        top: BOX_V.y,
        width: BOX_V.w,
        height: BOX_V.h,
        borderRadius: 18,
        overflow: "hidden",
        background: D.stage,
        border: "1px solid rgb(59,65,80)",
        boxShadow: "0 30px 90px rgba(0,0,0,0.55)",
        fontFamily: INTER,
        opacity: opacity < 1 ? opacity : undefined,
      }}
    >
      {/* Header: minimise, the channel + server, members / chat. */}
      <div style={{ height: M_HEADER, display: "flex", alignItems: "center", gap: 10, padding: "0 16px" }}>
        <PIcon name="chevronDown" size={24} color={D.text} />
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 6, color: "#fff", fontWeight: 700, fontSize: 18 }}>
            <DGlyph name="speaker" size={18} color={D.muted} />
            {VOICE.channel}
          </span>
          <span style={{ color: D.muted, fontSize: 12.5, marginTop: 1 }}>{SERVER.name}</span>
        </div>
        <span style={{ flex: 1 }} />
        <DGlyph name="chat" size={22} color={D.text} />
        <PIcon name="users" size={22} color={D.text} />
      </div>
      {VOICE.members.map((m, i) => (
        <CallTile
          key={m.name}
          person={m}
          speaking={speaking[m.name] ?? 0}
          muted={VOICE.muted.includes(m.name)}
          style={{
            left: M_SIDE + (i % 2) * (M_TILE_W + M_TILE_GAP),
            top: M_TILES_TOP + Math.floor(i / 2) * (M_TILE_H + M_TILE_GAP),
            width: M_TILE_W,
            height: M_TILE_H,
          }}
          avatar={92}
          label={15}
        />
      ))}
      {/* The call's control sheet. */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: M_SHEET_TOP,
          bottom: 0,
          background: D.panel,
          borderRadius: "20px 20px 0 0",
          borderTop: `1px solid ${withAlpha("#ffffff", 0.06)}`,
        }}
      >
        <div style={{ width: 40, height: 5, borderRadius: 3, background: withAlpha("#ffffff", 0.18), margin: "10px auto 0" }} />
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: M_CTRL_CY - M_SHEET_TOP - M_CTRL.size / 2,
            display: "flex",
            justifyContent: "center",
            gap: M_CTRL.gap,
          }}
        >
          {M_CTRL_ITEMS.map((id) => (
            <div
              key={id}
              style={{
                width: M_CTRL.size,
                height: M_CTRL.size,
                borderRadius: "50%",
                background: id === "hangup" ? D.red : hover === id || pressed === id ? D.controlLit : D.control,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transform: pressed === id ? "scale(0.92)" : undefined,
              }}
            >
              <DGlyph name={id} size={id === "rocket" ? 32 : 27} color="#fff" />
            </div>
          ))}
        </div>
      </div>
      {/* The Activities sheet over a scrim. */}
      {sh > 0.001 && (
        <>
          <div style={{ position: "absolute", inset: 0, background: `rgba(0,0,0,${0.55 * sh})` }} />
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: MS_TOP,
              bottom: 0,
              boxSizing: "border-box",
              padding: `0 ${MS_PAD}px`,
              background: DT.sidebar,
              borderRadius: "20px 20px 0 0",
              borderTop: `1px solid ${withAlpha("#ffffff", 0.08)}`,
              boxShadow: "0 -18px 50px rgba(0,0,0,0.5)",
              transform: `translateY(${(1 - sh) * (BOX_V.h - MS_TOP)}px)`,
            }}
          >
            <div style={{ width: 40, height: 5, borderRadius: 3, background: withAlpha("#ffffff", 0.18), margin: "10px auto 0" }} />
            <div style={{ height: MS_HEAD - 15, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={{ color: "#fff", fontSize: 20, fontWeight: 700 }}>Activities</span>
                <span style={{ display: "flex", alignItems: "center", gap: 5, color: D.muted, fontSize: 13.5 }}>
                  Start one in <DGlyph name="speaker" size={14} color={D.muted} /> {VOICE.channel}
                </span>
              </div>
              <PIcon name="close" size={22} color={D.muted} />
            </div>
            <DweebCard width={MS_COVER_W} hover={dweebHover} pressed={dweebPressed} />
          </div>
        </>
      )}
    </div>
  );
};
