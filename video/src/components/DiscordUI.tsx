import React from "react";
import { COLORS } from "../theme";
import { INTER } from "../fonts";
import { Icon, IconName } from "./Icon";
import { Mascot } from "./Mascot";
import { withAlpha } from "../lib/color";
import { useDiscord } from "./editor/scale";
import { NebulaIcon, UserAvatar } from "./editor/people";
import { PIcon } from "./editor/ProductIcon";
import type { ButtonKind, CastMember } from "../story/campaign";

/**
 * Discord surfaces: the message the editor previews and the Discord client it
 * lands in. Metrics are the ones DWEEB's preview measured off the live Discord
 * client (src/features/preview/**.module.css + src/styles/tokens.css
 * --discord-*), multiplied by the DiscordScale zoom (see editor/scale.tsx):
 * 16px/1.375 body, 24px H1, 32px buttons with 8px radius, 40px selects, a
 * 2fr/1fr 12:7 three-image gallery, 8px-radius containers with a 4px accent.
 */

/* ── Tokens the theme doesn't carry (tokens.css --discord-*) ─────────────── */

export const DT = {
  canvas: COLORS.dBgPrimary, // #313338 — the sanctioned preview canvas
  container: COLORS.dBgSecondary, // #2b2d31 (paired to the canvas)
  containerBorder: "rgba(148,148,156,0.12)",
  text: COLORS.dText, // #efeff1
  strong: "#fbfbfb",
  muted: COLORS.dTextMuted, // #abacb2
  faint: "#81828a",
  accent: "#5865f2",
  btnBorder: "rgba(255,255,255,0.08)",
  btnSecondaryBorder: "rgba(153,153,153,0.04)",
  btnSecondaryHover: "rgba(151,151,159,0.2)",
  selectBg: "rgba(0,0,0,0.12)",
  selectBorder: "rgba(150,150,160,0.2)",
  divider: COLORS.dDivider,
  rail: "#1e1f22",
  sidebar: "#2b2d31",
} as const;

/**
 * A glow that is always a valid colour per kind, drawn as a ring + halo so it
 * reads on the translucent grey Link/secondary fill too. (v5 appended "aa" to
 * the kind's background — invalid on an rgba() token, so the whole shadow was
 * dropped and four "it just changed" beats never lit up.)
 */
export const BUTTON_GLOW: Record<ButtonKind, string> = {
  primary: "#6f7bff",
  secondary: "rgba(214,218,232,0.9)",
  success: "#2dc06b",
  danger: "#f04747",
  link: "rgba(214,218,232,0.9)",
};
/** The plugin-attach moment's gold (the Giveaway "now it works" glow). */
export const ATTACH_GOLD = "#f0b232";

const BTN_BG: Record<ButtonKind, { bg: string; hover: string; border: string; ink: string }> = {
  primary: { bg: COLORS.dButtonPrimary, hover: "#4654c9", border: DT.btnBorder, ink: "#fff" },
  secondary: { bg: COLORS.dButtonSecondary, hover: DT.btnSecondaryHover, border: DT.btnSecondaryBorder, ink: DT.strong },
  success: { bg: COLORS.dButtonSuccess, hover: "#006d39", border: DT.btnBorder, ink: "#fff" },
  danger: { bg: COLORS.dButtonDanger, hover: "#ad2530", border: DT.btnBorder, ink: "#fff" },
  link: { bg: COLORS.dButtonSecondary, hover: DT.btnSecondaryHover, border: DT.btnSecondaryBorder, ink: DT.strong },
};

/* ── Emoji-aware text ───────────────────────────────────────────────────── */

// VS16 (U+FE0F) and ZWJ (U+200D) keep 🖥️ / 👩‍💻-style sequences in one span.
const VS16 = String.fromCharCode(0xfe0f);
const ZWJ = String.fromCharCode(0x200d);
const EMOJI_RE = new RegExp(
  `(\\p{Extended_Pictographic}(?:${VS16}|${ZWJ}\\p{Extended_Pictographic}|${VS16}${ZWJ}\\p{Extended_Pictographic})*)`,
  "u",
);

/** Split text so emoji can render at Discord's 1.375em (text) scale. */
export function withEmoji(text: string, scale = 1.375): React.ReactNode[] {
  return text.split(EMOJI_RE).map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} style={{ fontSize: `${scale}em`, lineHeight: 1, verticalAlign: "-0.12em" }}>
        {part}
      </span>
    ) : (
      <React.Fragment key={i}>{part}</React.Fragment>
    ),
  );
}

/* ── Discord app chrome (desktop) ────────────────────────────────────────── */

export type Channel =
  | { cat: string }
  | {
      name: string;
      kind?: "text" | "voice" | "announcement";
      active?: boolean;
      locked?: boolean;
      unread?: boolean;
      /** Extra node rendered under the row (e.g. voice participants). */
      extra?: React.ReactNode;
      /** Row opacity/slide for animated appearance (0..1). */
      reveal?: number;
    };

const ChannelGlyph: React.FC<{ kind?: "text" | "voice" | "announcement"; locked?: boolean; color: string; size: number }> = ({
  kind = "text",
  locked,
  color,
  size,
}) => {
  if (locked) return <PIcon name="lock" size={size} color={color} />;
  if (kind === "voice") return <Icon name="users" size={size} color={color} />;
  if (kind === "announcement") return <PIcon name="announcement" size={size} color={color} />;
  return <PIcon name="hash" size={size} color={color} strokeWidth={2} />;
};

/**
 * The desktop Discord client: server rail (Nebula selected), channel sidebar,
 * channel header, the message area (children) and the composer. Fictional
 * server, structurally faithful.
 */
export const DiscordShell: React.FC<{
  width: number;
  height: number;
  serverName?: string;
  channels: Channel[];
  header: string;
  headerKind?: "text" | "voice" | "announcement";
  inputGhost?: string;
  /**
   * "bottom" stacks messages up from the composer the way Discord does (the
   * newest post sits right above the input, older ones scroll off the top).
   * v5 scenes position their own content: "top" (default).
   */
  anchor?: "top" | "bottom";
  children: React.ReactNode;
}> = ({
  width,
  height,
  serverName = "Nebula Gaming",
  channels,
  header,
  headerKind = "text",
  inputGhost = "Message #announcements",
  anchor = "top",
  children,
}) => (
  <div
    style={{
      width,
      height,
      display: "flex",
      background: DT.canvas,
      borderRadius: 16,
      overflow: "hidden",
      border: `1px solid ${COLORS.dBgTertiary}`,
      boxShadow: "0 40px 120px rgba(0,0,0,0.6)",
      fontFamily: INTER,
    }}
  >
    {/* server rail */}
    <div
      style={{
        width: 74,
        background: DT.rail,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "14px 0",
        gap: 10,
        flexShrink: 0,
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
        <div
          style={{
            position: "absolute",
            left: -13,
            top: 8,
            width: 4,
            height: 32,
            borderRadius: "0 4px 4px 0",
            background: "#fff",
          }}
        />
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

    {/* channel sidebar */}
    <div style={{ width: 250, background: DT.sidebar, display: "flex", flexDirection: "column", flexShrink: 0 }}>
      <div
        style={{
          height: 52,
          display: "flex",
          alignItems: "center",
          padding: "0 16px",
          fontWeight: 700,
          fontSize: 16.5,
          color: "#fff",
          borderBottom: `1px solid ${COLORS.dBgTertiary}`,
          justifyContent: "space-between",
        }}
      >
        {serverName}
        <PIcon name="chevronDown" size={16} color={DT.muted} />
      </div>
      <div style={{ padding: "12px 8px", display: "flex", flexDirection: "column", gap: 2 }}>
        {channels.map((c, i) => {
          if ("cat" in c)
            return (
              <div
                key={`cat-${i}`}
                style={{ padding: "10px 8px 4px", fontSize: 12, fontWeight: 700, letterSpacing: "0.02em", color: DT.muted }}
              >
                {c.cat}
              </div>
            );
          const reveal = c.reveal ?? 1;
          if (reveal <= 0.001) return null;
          const ink = c.active ? "#fff" : c.unread ? DT.text : COLORS.dChannel;
          return (
            <div key={c.name} style={{ opacity: reveal, transform: reveal < 1 ? `translateX(${(1 - reveal) * -14}px)` : undefined }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 8px",
                  borderRadius: 6,
                  background: c.active ? "rgba(151,151,159,0.24)" : "transparent",
                  color: ink,
                  fontWeight: c.active || c.unread ? 600 : 500,
                  fontSize: 15.5,
                }}
              >
                <ChannelGlyph kind={c.kind} locked={c.locked} color={c.active ? "#fff" : COLORS.dChannel} size={18} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                {c.unread && <span style={{ marginLeft: "auto", width: 8, height: 8, borderRadius: 4, background: "#fff" }} />}
              </div>
              {c.extra}
            </div>
          );
        })}
      </div>
    </div>

    {/* main column */}
    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
      <div
        style={{
          height: 52,
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "0 18px",
          borderBottom: `1px solid ${COLORS.dBgTertiary}`,
          color: "#fff",
          fontWeight: 700,
          fontSize: 16.5,
          flexShrink: 0,
        }}
      >
        <ChannelGlyph kind={headerKind} color={DT.muted} size={20} />
        {header}
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          padding: "18px 22px",
          overflow: "hidden",
          position: "relative",
          display: anchor === "bottom" ? "flex" : undefined,
          flexDirection: "column",
          justifyContent: "flex-end",
        }}
      >
        {children}
      </div>
      <div style={{ padding: "0 22px 20px", flexShrink: 0 }}>
        <div
          style={{
            height: 46,
            borderRadius: 10,
            background: COLORS.dInput,
            border: `1px solid ${DT.selectBorder}`,
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "0 16px",
            color: DT.muted,
            fontSize: 15.5,
          }}
        >
          <PIcon name="plus" size={20} color={DT.muted} />
          {inputGhost}
        </div>
      </div>
    </div>
  </div>
);

/**
 * Discord MOBILE — the portrait landing: channel header, a scrolling message
 * list (children) and the composer, full width. Width-flexible; the height is
 * the caller's (a portrait stage column).
 */
export const DiscordMobile: React.FC<{
  channel: string;
  serverName?: string;
  height: number | string;
  inputGhost?: string;
  /** "bottom": the newest message sits above the composer, like Discord. */
  anchor?: "top" | "bottom";
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ channel, serverName = "Nebula Gaming", height, inputGhost, anchor = "bottom", children, style }) => {
  const { d } = useDiscord();
  return (
    <div
      style={{
        width: "100%",
        height,
        display: "flex",
        flexDirection: "column",
        background: DT.canvas,
        borderRadius: d(18),
        overflow: "hidden",
        border: `1px solid ${COLORS.dBgTertiary}`,
        fontFamily: INTER,
        ...style,
      }}
    >
      <div
        style={{
          height: d(58),
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: d(10),
          padding: `0 ${d(14)}px`,
          borderBottom: `1px solid ${COLORS.dBgTertiary}`,
          background: DT.canvas,
        }}
      >
        <PIcon name="chevronRight" size={d(22)} color={DT.muted} style={{ transform: "scaleX(-1)" }} />
        <NebulaIcon size={d(30)} shape="rounded" />
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span style={{ display: "flex", alignItems: "center", gap: d(4), color: "#fff", fontWeight: 700, fontSize: d(17) }}>
            <PIcon name="hash" size={d(17)} color={DT.muted} strokeWidth={2.2} />
            {channel}
          </span>
          <span style={{ color: DT.muted, fontSize: d(12), marginTop: d(1) }}>{serverName}</span>
        </div>
        <div style={{ flex: 1 }} />
        <PIcon name="search" size={d(20)} color={DT.muted} />
        <PIcon name="users" size={d(20)} color={DT.muted} />
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
          position: "relative",
          padding: `${d(14)}px ${d(12)}px ${d(6)}px`,
          display: "flex",
          flexDirection: "column",
          justifyContent: anchor === "bottom" ? "flex-end" : "flex-start",
        }}
      >
        {children}
      </div>
      <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: d(10), padding: `${d(10)}px ${d(12)}px ${d(14)}px` }}>
        <div
          style={{
            width: d(38),
            height: d(38),
            borderRadius: "50%",
            background: "rgba(151,151,159,0.16)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <PIcon name="plus" size={d(20)} color={DT.muted} />
        </div>
        <div
          style={{
            flex: 1,
            height: d(40),
            borderRadius: d(20),
            background: "rgba(0,0,0,0.18)",
            border: `1px solid ${DT.selectBorder}`,
            display: "flex",
            alignItems: "center",
            padding: `0 ${d(14)}px`,
            color: DT.faint,
            fontSize: d(15),
            gap: d(8),
          }}
        >
          <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden" }}>{inputGhost ?? `Message #${channel}`}</span>
          <PIcon name="emoji" size={d(20)} color={DT.muted} />
        </div>
      </div>
    </div>
  );
};

/* ── Message ────────────────────────────────────────────────────────────── */

export type MessageAvatar = "nebula" | "mascot" | CastMember;

/**
 * A message: avatar, username, APP tag (plain "APP" — no ✓, like the preview
 * and a webhook post), timestamp, and the content column. `time` defaults to
 * Discord's "Today at 9:41 AM"; the editor preview passes PREVIEW_TIME.
 */
export const DMsg: React.FC<{
  author: string;
  time?: string;
  app?: boolean;
  /** Legacy: tint for an initial-disc avatar. */
  avatarColor?: string;
  /** Legacy: the DWEEB mascot avatar (only for DWEEB's own replies). */
  mascot?: boolean;
  avatar?: MessageAvatar;
  edited?: boolean;
  ephemeral?: boolean;
  /** 0..1 — dims an older post above the hero message. */
  dim?: number;
  children: React.ReactNode;
}> = ({
  author,
  time = "Today at 9:41 AM",
  app = true,
  avatarColor = COLORS.blurple,
  mascot = false,
  avatar,
  edited,
  ephemeral,
  dim = 0,
  children,
}) => {
  const { d } = useDiscord();
  const kind: MessageAvatar = avatar ?? (mascot ? "mascot" : { name: author, color: avatarColor });
  const size = d(40);
  return (
    <div style={{ display: "flex", gap: d(16), fontFamily: INTER, position: "relative", opacity: 1 - dim * 0.55 }}>
      {kind === "nebula" ? (
        <NebulaIcon size={size} />
      ) : kind === "mascot" ? (
        <div
          style={{
            width: size,
            height: size,
            borderRadius: "50%",
            overflow: "hidden",
            flexShrink: 0,
            background: COLORS.blurple,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Mascot size={size * 0.92} glow={false} look={false} />
        </div>
      ) : (
        <UserAvatar person={kind} size={size} />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: d(6), marginBottom: d(3), minHeight: d(22) }}>
          <span style={{ color: DT.strong, fontWeight: 600, fontSize: d(16), whiteSpace: "nowrap" }}>{author}</span>
          {app && (
            <span
              style={{
                background: DT.accent,
                color: "#fff",
                fontSize: d(10.5),
                fontWeight: 600,
                lineHeight: `${d(15)}px`,
                padding: `0 ${d(4)}px`,
                borderRadius: d(4),
                letterSpacing: "0.02em",
              }}
            >
              APP
            </span>
          )}
          <span style={{ color: DT.faint, fontSize: d(12), whiteSpace: "nowrap" }}>{time}</span>
          {edited && <span style={{ color: DT.faint, fontSize: d(11) }}>(edited)</span>}
        </div>
        {children}
        {ephemeral && (
          <div style={{ display: "flex", alignItems: "center", gap: d(6), marginTop: d(8), color: DT.muted, fontSize: d(13) }}>
            <Icon name="eye" size={d(14)} color={DT.muted} />
            Only you can see this · <span style={{ color: COLORS.dLink }}>Dismiss message</span>
          </div>
        )}
      </div>
    </div>
  );
};

/* ── Components V2 blocks ───────────────────────────────────────────────── */

/** Container: #2b2d31 card, hairline border, 8px radius, 4px accent stripe. */
export const DContainer: React.FC<{
  accent?: string;
  children: React.ReactNode;
  width?: number | string;
  /** Preview selection ring (ComponentRenderer .selected: 2px accent). */
  selected?: number;
  style?: React.CSSProperties;
}> = ({ accent = COLORS.green, children, width = "100%", selected = 0, style }) => {
  const { d } = useDiscord();
  return (
    <div
      style={{
        position: "relative",
        background: DT.container,
        border: `1px solid ${DT.containerBorder}`,
        borderRadius: d(8),
        overflow: "hidden",
        width,
        maxWidth: d(600),
        boxSizing: "border-box",
        boxShadow: selected > 0.01 ? `0 0 0 ${d(2)}px ${withAlpha(DT.accent, selected)}` : undefined,
        ...style,
      }}
    >
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: d(4), background: accent }} />
      <div style={{ padding: d(16), display: "flex", flexDirection: "column", gap: d(8) }}>{children}</div>
    </div>
  );
};

/**
 * A selection ring around any preview block (the gallery, a button…).
 * `maxWidth` (Discord px, pre-zoom) keeps the ring hugging a capped block
 * such as the 400px select.
 */
export const DSelected: React.FC<{ on: number; radius?: number; maxWidth?: number; children: React.ReactNode }> = ({
  on,
  radius = 8,
  maxWidth,
  children,
}) => {
  const { d } = useDiscord();
  return (
    <div
      style={{
        borderRadius: d(radius),
        maxWidth: maxWidth ? d(maxWidth) : undefined,
        boxShadow: on > 0.01 ? `0 0 0 ${d(2)}px ${withAlpha(DT.accent, on)}` : undefined,
      }}
    >
      {children}
    </div>
  );
};

/**
 * A Text Display rendered from its markdown, the way the preview renders it:
 * "# " / "## " / "### " headings (24/20/16px bold, brighter), "-# " subtext,
 * paragraphs; unicode emoji at 1.375em. `highlight` wipes a green marker over
 * one substring in reading order (the AI's rewrite).
 */
export const DTextDisplay: React.FC<{
  content: string;
  highlight?: { text: string; t: number; color?: string };
}> = ({ content, highlight }) => {
  const { d } = useDiscord();
  const lines = content.split("\n");
  // **bold** spans (the only inline style the film's templates use).
  const inline = (text: string): React.ReactNode[] =>
    text.split(/\*\*(.+?)\*\*/).map((part, i) =>
      i % 2 === 1 ? (
        <strong key={i} style={{ fontWeight: 700, color: DT.strong }}>
          {withEmoji(part)}
        </strong>
      ) : (
        <React.Fragment key={i}>{withEmoji(part)}</React.Fragment>
      ),
    );
  const mark = (line: string): React.ReactNode => {
    if (!highlight || highlight.t <= 0) return inline(line);
    const at = line.indexOf(highlight.text);
    if (at < 0) return inline(line);
    const c = highlight.color ?? "rgba(87,242,135,0.3)";
    return (
      <>
        {inline(line.slice(0, at))}
        <span
          style={{
            backgroundImage: `linear-gradient(${c}, ${c})`,
            backgroundRepeat: "no-repeat",
            backgroundSize: `${Math.max(0, Math.min(1, highlight.t)) * 100}% 100%`,
            borderRadius: d(3),
            WebkitBoxDecorationBreak: "slice",
          }}
        >
          {inline(highlight.text)}
        </span>
        {inline(line.slice(at + highlight.text.length))}
      </>
    );
  };
  return (
    <div style={{ fontFamily: INTER, color: DT.text, fontSize: d(16), lineHeight: 1.375 }}>
      {lines.map((line, i) => {
        if (line.startsWith("- ")) {
          return (
            <div key={i} style={{ display: "flex", gap: d(8), paddingLeft: d(6) }}>
              <span style={{ color: DT.text }}>•</span>
              <span style={{ minWidth: 0 }}>{mark(line.slice(2))}</span>
            </div>
          );
        }
        if (line.startsWith("> ")) {
          return (
            <div key={i} style={{ display: "flex", gap: d(12) }}>
              <span style={{ width: d(4), borderRadius: d(4), background: "#4e5058", flexShrink: 0 }} />
              <span style={{ minWidth: 0 }}>{mark(line.slice(2))}</span>
            </div>
          );
        }
        const h = /^(#{1,3}) (.*)$/.exec(line);
        if (h) {
          const size = h[1].length === 1 ? 24 : h[1].length === 2 ? 20 : 16;
          return (
            <div
              key={i}
              style={{
                fontSize: d(size),
                fontWeight: 700,
                color: DT.strong,
                lineHeight: 1.375,
                margin: `${i === 0 ? 0 : d(16)}px 0 ${i === lines.length - 1 ? 0 : d(8)}px`,
                minHeight: `${1.375}em`,
              }}
            >
              {mark(h[2])}
            </div>
          );
        }
        if (line.startsWith("-# ")) {
          return (
            <div key={i} style={{ fontSize: d(13), color: DT.muted }}>
              {mark(line.slice(3))}
            </div>
          );
        }
        return (
          <div key={i} style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", minHeight: line ? undefined : "1.375em" }}>
            {mark(line)}
          </div>
        );
      })}
    </div>
  );
};

/* ── Media gallery ──────────────────────────────────────────────────────── */

export type TileArt = "hero" | "sun" | "ridge" | "aurora";

const NEBULA_STARS = new Array(18).fill(0).map((_, i) => ({
  left: `${(i * 47 + 9) % 94}%`,
  top: `${(i * 29 + 7) % 72}%`,
  size: 1 + (i % 3),
  opacity: 0.34 + (i % 4) * 0.14,
}));

const TILE_BG: Record<TileArt, string> = {
  hero: "linear-gradient(142deg, #12172f 0%, #433b96 45%, #167f78 100%)",
  sun: "linear-gradient(155deg, #211b43 0%, #a34775 52%, #f0a05b 100%)",
  ridge: "linear-gradient(145deg, #081a30 0%, #174f76 48%, #4d65d8 100%)",
  aurora: "linear-gradient(160deg, #06131f 0%, #0f3a4a 45%, #1f8f6d 78%, #9dffb8 100%)",
};

/** Painted Season 4 art (no image files: deterministic and resolution-free). */
export const NebulaTile: React.FC<{ kind: TileArt; label?: boolean }> = ({ kind, label = true }) => (
  <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: TILE_BG[kind] }}>
    {NEBULA_STARS.slice(0, kind === "hero" ? 18 : 9).map((star, i) => (
      <div
        key={i}
        style={{
          position: "absolute",
          left: star.left,
          top: star.top,
          width: star.size,
          height: star.size,
          borderRadius: "50%",
          background: "#fff",
          opacity: star.opacity,
          boxShadow: "0 0 5px rgba(255,255,255,.55)",
        }}
      />
    ))}
    {kind === "hero" && (
      <>
        <div
          style={{
            position: "absolute",
            width: "58%",
            aspectRatio: "1",
            borderRadius: "50%",
            right: "-4%",
            bottom: "-38%",
            background: "radial-gradient(circle at 36% 28%, #8fffd2, #317f9f 35%, #25265c 72%)",
            boxShadow: "0 0 34px rgba(87,242,135,.32)",
          }}
        />
        <div
          style={{
            position: "absolute",
            width: "86%",
            height: "34%",
            right: "-16%",
            bottom: "12%",
            border: "3px solid rgba(230,235,255,.72)",
            borderRadius: "50%",
            transform: "rotate(-13deg)",
            boxShadow: "0 0 14px rgba(255,255,255,.16)",
          }}
        />
        {label && (
          <div
            style={{
              position: "absolute",
              left: "6%",
              bottom: "9%",
              fontFamily: INTER,
              fontSize: "clamp(8px, 1.1em, 40px)",
              fontWeight: 900,
              letterSpacing: "0.16em",
              color: "rgba(255,255,255,.88)",
              textShadow: "0 2px 12px rgba(0,0,0,.5)",
            }}
          >
            SEASON FOUR
          </div>
        )}
      </>
    )}
    {kind === "sun" && (
      <>
        <div
          style={{
            position: "absolute",
            width: "38%",
            aspectRatio: "1",
            borderRadius: "50%",
            right: "14%",
            top: "-12%",
            background: "radial-gradient(circle at 38% 38%, #fff5c9, #ffb45d 48%, #ec5c72 100%)",
            boxShadow: "0 0 24px rgba(255,170,91,.62)",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: "34%",
            background: "linear-gradient(165deg, transparent 12%, #241c4d 13% 45%, #11162d 46%)",
          }}
        />
      </>
    )}
    {kind === "ridge" && (
      <>
        <div style={{ position: "absolute", inset: 0, background: "radial-gradient(circle at 74% 22%, rgba(134,218,255,.5), transparent 34%)" }} />
        <div
          style={{
            position: "absolute",
            left: "-5%",
            right: "42%",
            bottom: "-12%",
            height: "72%",
            background: "linear-gradient(145deg, #1c2345, #0a1125)",
            clipPath: "polygon(0 100%, 18% 46%, 34% 69%, 58% 18%, 100% 100%)",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: "32%",
            right: "-6%",
            bottom: "-15%",
            height: "62%",
            background: "linear-gradient(145deg, #234468, #101a39)",
            clipPath: "polygon(0 100%, 30% 35%, 47% 58%, 66% 14%, 100% 100%)",
          }}
        />
      </>
    )}
    {kind === "aurora" && (
      <>
        <div
          style={{
            position: "absolute",
            left: "-10%",
            right: "-10%",
            top: "8%",
            height: "46%",
            background: "linear-gradient(100deg, transparent 10%, rgba(87,242,135,.55) 35%, rgba(88,101,242,.4) 62%, transparent 88%)",
            filter: "blur(6px)",
            transform: "skewY(-8deg)",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: "30%",
            background: "linear-gradient(175deg, transparent 10%, #0b1a24 12%, #050b12 60%)",
          }}
        />
      </>
    )}
    <div style={{ position: "absolute", inset: 0, boxShadow: "inset 0 0 30px rgba(0,0,0,.2)" }} />
  </div>
);

/**
 * Discord's 3-image gallery (MediaGalleryRenderer.module.css): a 2fr hero
 * beside two stacked 1fr cells, 4px gaps, one 8px-radius clip, ~12:7 overall.
 * `h` (legacy) pins the height instead of the aspect. `swap` crossfades one
 * tile to new art (the build beat's "check the gallery").
 */
export const DGallery: React.FC<{
  h?: number;
  art?: [TileArt, TileArt, TileArt];
  swap?: { index: 0 | 1 | 2; to: TileArt; t: number };
  selected?: number;
}> = ({ h, art = ["hero", "sun", "ridge"], swap, selected = 0 }) => {
  const { d } = useDiscord();
  const tile = (i: 0 | 1 | 2) => (
    <div style={{ position: "relative", overflow: "hidden", gridRow: i === 0 ? "1 / span 2" : undefined, fontSize: d(11) }}>
      <NebulaTile kind={art[i]} />
      {swap && swap.index === i && swap.t > 0 && (
        <div style={{ position: "absolute", inset: 0, opacity: Math.min(1, swap.t) }}>
          <NebulaTile kind={swap.to} />
        </div>
      )}
    </div>
  );
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "2fr 1fr",
        gridTemplateRows: "1fr 1fr",
        gap: d(4),
        borderRadius: d(8),
        overflow: "hidden",
        maxWidth: d(600),
        width: "100%",
        ...(h !== undefined ? { height: h } : { aspectRatio: "12 / 7" }),
        boxShadow: selected > 0.01 ? `0 0 0 ${d(2)}px ${withAlpha(DT.accent, selected)}` : undefined,
      }}
    >
      {tile(0)}
      {tile(1)}
      {tile(2)}
    </div>
  );
};

/* ── Buttons ────────────────────────────────────────────────────────────── */

/**
 * A Discord button at the measured size (32px, 8px radius, 14px/500 label,
 * emoji at 1.375em, Link buttons with the ↗ glyph). `count` restamps the label
 * the way the giveaway plugin does: "Enter giveaway (129)".
 */
export const DBtn: React.FC<{
  label: string;
  kind?: ButtonKind;
  emoji?: string;
  /** Legacy film line icon. */
  icon?: IconName;
  disabled?: boolean;
  /** true or 0..1 strength. */
  glow?: boolean | number;
  glowColor?: string;
  count?: number;
  hover?: boolean;
  pressed?: boolean;
}> = ({ label, kind = "secondary", emoji, icon, disabled = false, glow = false, glowColor, count, hover, pressed }) => {
  const { d } = useDiscord();
  const c = BTN_BG[kind];
  const g = typeof glow === "number" ? Math.max(0, Math.min(1, glow)) : glow ? 1 : 0;
  const gc = glowColor ?? BUTTON_GLOW[kind];
  const text = count === undefined ? label : `${label} (${count.toLocaleString("en-US")})`;
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: d(4),
        height: d(32),
        minWidth: d(60),
        boxSizing: "border-box",
        padding: `0 ${d(11)}px`,
        borderRadius: d(8),
        border: `1px solid ${c.border}`,
        background: hover || pressed ? c.hover : c.bg,
        color: c.ink,
        fontFamily: INTER,
        fontWeight: 500,
        fontSize: d(14),
        lineHeight: `${d(18)}px`,
        whiteSpace: "nowrap",
        opacity: disabled ? 0.5 : 1,
        transform: pressed ? "scale(0.96)" : undefined,
        boxShadow: g > 0.01 ? `0 0 0 ${d(2)}px ${withAlpha(gc, 0.9 * g)}, 0 0 ${d(24)}px ${withAlpha(gc, 0.6 * g)}` : undefined,
      }}
    >
      {emoji && <span style={{ fontSize: "1.375em", lineHeight: 1 }}>{emoji}</span>}
      {icon && <Icon name={icon} size={d(16)} color="#fff" />}
      <span>{text}</span>
      {kind === "link" && <PIcon name="externalLink" size={d(16)} color={c.ink} style={{ marginLeft: d(4), opacity: 0.8 }} />}
    </div>
  );
};

/** Action row: buttons wrap with an 8px gap. */
export const DRow: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { d } = useDiscord();
  return <div style={{ display: "flex", flexWrap: "wrap", gap: d(8), alignItems: "center" }}>{children}</div>;
};

export type SelectOption = { emoji: string; label: string; desc?: string; selected?: boolean };

/** String select (40px, 8px radius, translucent fill). `openP` 0..1 drops the options. */
export const DSelect: React.FC<{
  placeholder: string;
  options?: SelectOption[];
  openP?: number;
  width?: number | string;
  highlight?: number;
}> = ({ placeholder, options = [], openP = 0, width = "100%", highlight = -1 }) => {
  const { d } = useDiscord();
  return (
    <div style={{ width, maxWidth: d(400), fontFamily: INTER, position: "relative" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: d(8),
          minHeight: d(40),
          boxSizing: "border-box",
          padding: `${d(8)}px ${d(8)}px ${d(8)}px ${d(12)}px`,
          background: DT.selectBg,
          border: `1px solid ${DT.selectBorder}`,
          borderRadius: d(8),
          fontSize: d(16),
          fontWeight: 500,
        }}
      >
        <span style={{ flex: 1, minWidth: 0, color: DT.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {placeholder}
        </span>
        <PIcon name="chevronDown" size={d(18)} color={DT.text} style={{ transform: `rotate(${openP * 180}deg)` }} />
      </div>
      {openP > 0.02 && options.length > 0 && (
        <div
          style={{
            position: "absolute",
            top: `calc(100% + ${d(6)}px)`,
            left: 0,
            right: 0,
            background: DT.container,
            border: `1px solid ${DT.selectBorder}`,
            borderRadius: d(8),
            overflow: "hidden",
            opacity: Math.min(1, openP * 1.6),
            transform: `translateY(${(1 - openP) * -8}px)`,
            zIndex: 5,
            boxShadow: "0 18px 50px rgba(0,0,0,0.55)",
          }}
        >
          {options.map((o, i) => (
            <div
              key={o.label}
              style={{
                display: "flex",
                alignItems: "center",
                gap: d(11),
                padding: `${d(10)}px ${d(14)}px`,
                background: i === highlight ? "rgba(151,151,159,0.16)" : "transparent",
              }}
            >
              <span style={{ fontSize: d(19) }}>{o.emoji}</span>
              <div style={{ flex: 1 }}>
                <div style={{ color: DT.strong, fontWeight: 600, fontSize: d(15) }}>{o.label}</div>
                {o.desc && <div style={{ color: DT.muted, fontSize: d(13) }}>{o.desc}</div>}
              </div>
              {o.selected && <PIcon name="checkCircle" size={d(18)} color={COLORS.green} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/* ── Reactions ──────────────────────────────────────────────────────────── */

/** A reaction pill; `mine` is the blurple "you reacted" state; `pop` 0..1 bounces it in. */
export const DReaction: React.FC<{ emoji: string; count: number; mine?: boolean; pop?: number }> = ({
  emoji,
  count,
  mine = false,
  pop = 1,
}) => {
  const { d } = useDiscord();
  if (pop <= 0.001) return null;
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: d(6),
        height: d(28),
        boxSizing: "border-box",
        padding: `0 ${d(8)}px`,
        borderRadius: d(8),
        background: mine ? "rgba(88,101,242,0.15)" : "rgba(151,151,159,0.12)",
        border: `1px solid ${mine ? DT.accent : "transparent"}`,
        fontFamily: INTER,
        transform: pop < 1 ? `scale(${0.6 + pop * 0.4})` : undefined,
        opacity: Math.min(1, pop * 2),
      }}
    >
      <span style={{ fontSize: d(17), lineHeight: 1 }}>{emoji}</span>
      <span style={{ fontSize: d(14), fontWeight: 600, color: mine ? "#dee0fc" : DT.muted, fontVariantNumeric: "tabular-nums" }}>
        {count}
      </span>
    </div>
  );
};
