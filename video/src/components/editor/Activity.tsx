import React from "react";
import { COLORS } from "../../theme";
import { INTER } from "../../fonts";
import { withAlpha } from "../../lib/color";
import { CAST, SERVER, type CastMember } from "../../story/campaign";
import { NebulaIcon, UserAvatar } from "./people";
import { PIcon } from "./ProductIcon";
import { useUi } from "./scale";
import { IconBtn } from "./chrome";
import { ChannelChip, SendButton, textWidth } from "./ActionBar";

/**
 * The Discord Activity's own chrome (src/activity/ActivityBar.tsx +
 * PresenceDock.tsx). Story locks honoured: the destination SERVER is fixed —
 * a static server badge, no switcher — and only the channel chip moves (it is
 * shared with the room); the bottom-right dock is the invite control, the whole
 * bar clickable, avatars only, with the tooltip "Invite people to edit
 * together".
 */

export type ActivityControl = "channel" | "save" | "directory" | "restore" | "more" | "undo" | "redo" | "post";

type ActivityUtility = "save" | "directory" | "restore";
const ACTIVITY_UTILITY_ICON = { save: "save", directory: "bookmark", restore: "history" } as const;

/**
 * The Activity bar's collapse ladder (ActivityBar.tsx, same rules as the web
 * bar): tighten first (no dividers, 30px More/Undo/Redo, 2px gaps), then fold
 * Restore, Message directory, Save into More. "⋯" always shows — Open on web,
 * JSON and feedback live there at every width.
 */
export function activityBarPlan(widthPx: number, k: number, channel = "events", showServerName = false) {
  const chipW = 8 + 16 + 4 + textWidth(channel, 13) + 4 + 14 + 8;
  const left = 32 + (showServerName ? 8 + textWidth(SERVER.name, 13) : 0) + 8 + chipW;
  const all: ActivityUtility[] = ["save", "directory", "restore"];
  const need = (compact: boolean, n: number) => {
    const small = compact ? 30 : 36;
    const items = [...Array(n).fill(36), small, ...(compact ? [] : [9]), small, small, ...(compact ? [] : [9]), 80];
    return (compact ? 16 : 24) + left + (compact ? 8 : 12) + items.reduce((s, w) => s + w, 0) + (compact ? 2 : 4) * (items.length - 1);
  };
  const avail = widthPx / k;
  if (need(false, 3) <= avail) return { compact: false, utilities: all };
  for (let n = 3; n >= 0; n--) if (need(true, n) <= avail || n === 0) return { compact: true, utilities: all.slice(0, n) };
  return { compact: true, utilities: [] as ActivityUtility[] };
}

/** The Activity bar: 44px, server badge + "# events" chip · icons · ⋯ · Undo/Redo · Post. */
export const ActivityBar: React.FC<{
  /** Bar width in px (world) — drives the collapse ladder. Omit for the full bar. */
  width?: number;
  channel?: string;
  hover?: ActivityControl | null;
  pressed?: ActivityControl | null;
  glow?: Partial<Record<ActivityControl, number>>;
  canUndo?: boolean;
  canRedo?: boolean;
  /**
   * Film aid: print the server's name beside its badge. The product shows the
   * icon alone (its name is the badge's tooltip, "Posting to Nebula Gaming").
   */
  showServerName?: boolean;
}> = ({ width, channel = "events", hover = null, pressed = null, glow = {}, canUndo = true, canRedo = false, showServerName = false }) => {
  const { k, u } = useUi();
  const plan = width ? activityBarPlan(width, k, channel, showServerName) : { compact: false, utilities: ["save", "directory", "restore"] as ActivityUtility[] };
  const small = plan.compact ? "sm" : "md";
  const sep = plan.compact ? null : (
    <span style={{ width: 1, alignSelf: "stretch", margin: `${u(8)}px ${u(4)}px`, background: COLORS.border, flexShrink: 0 }} />
  );
  return (
    <div
      style={{
        width: width ?? "100%",
        height: u(44),
        boxSizing: "border-box",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: u(plan.compact ? 8 : 12),
        padding: `0 ${u(plan.compact ? 8 : 12)}px`,
        background: COLORS.bgElevated,
        borderBottom: `${u(1)}px solid ${COLORS.border}`,
        fontFamily: INTER,
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: u(8), minWidth: 0 }}>
        {/* Static server badge: posting here, fixed (no dropdown). */}
        <span style={{ display: "flex", padding: u(2), flexShrink: 0 }}>
          <NebulaIcon size={u(28)} shape="rounded" />
        </span>
        {showServerName && (
          <span style={{ fontSize: u(13), fontWeight: 600, color: COLORS.textMuted, whiteSpace: "nowrap" }}>{SERVER.name}</span>
        )}
        <ChannelChip channel={channel} hover={hover === "channel"} glow={glow.channel} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: u(plan.compact ? 2 : 4), flexShrink: 0 }}>
        {plan.utilities.map((ut) => (
          <IconBtn key={ut} name={ACTIVITY_UTILITY_ICON[ut]} hover={hover === ut} pressed={pressed === ut} glow={glow[ut]} />
        ))}
        <IconBtn name="moreHorizontal" size={small} hover={hover === "more"} pressed={pressed === "more"} glow={glow.more} />
        {sep}
        <IconBtn name="undo" size={small} hover={hover === "undo"} pressed={pressed === "undo"} disabled={!canUndo} glow={glow.undo} />
        <IconBtn name="redo" size={small} hover={hover === "redo"} pressed={pressed === "redo"} disabled={!canRedo} glow={glow.redo} />
        {sep}
        <SendButton label="Post" hover={hover === "post"} pressed={pressed === "post"} glow={glow.post} />
      </div>
    </div>
  );
};

export type DockPerson = CastMember & {
  /** 0..1 pop-in (a teammate joining). Default 1. */
  join?: number;
};

/**
 * The presence dock: a "+" affordance on the left (it lights up on hover),
 * then everyone in the room as avatars — you first, ringed green while live.
 * The whole bar is the invite button.
 */
export const PresenceDock: React.FC<{
  people?: DockPerson[];
  hover?: boolean;
  pressed?: boolean;
  /** 0..1 attention glow on the whole dock. */
  glow?: number;
}> = ({ people = [CAST.aria as DockPerson], hover = false, pressed = false, glow = 0 }) => {
  const { u } = useUi();
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: u(8),
        padding: `${u(5)}px ${u(8)}px`,
        borderRadius: u(14),
        background: COLORS.bgElevated,
        border: `${u(1)}px solid ${hover ? COLORS.borderStrong : COLORS.border}`,
        boxShadow: [
          `0 ${u(8)}px ${u(24)}px rgba(0,0,0,0.5)`,
          glow > 0.01 ? `0 0 0 ${u(2)}px ${withAlpha(COLORS.blurple, 0.8 * glow)}, 0 0 ${u(22)}px ${withAlpha(COLORS.blurple, 0.5 * glow)}` : "",
        ]
          .filter(Boolean)
          .join(", "),
        transform: pressed ? "scale(0.96)" : undefined,
        fontFamily: INTER,
      }}
    >
      <span
        style={{
          width: u(28),
          height: u(28),
          borderRadius: "50%",
          boxSizing: "border-box",
          border: `${u(1)}px solid ${hover || pressed ? COLORS.blurple : COLORS.border}`,
          background: hover || pressed ? COLORS.blurple : COLORS.bg,
          color: hover || pressed ? "#fff" : COLORS.textMuted,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <PIcon name="plus" size={u(16)} />
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", marginLeft: "auto" }}>
        {people.map((p, i) => {
          const j = Math.max(0, Math.min(1, p.join ?? 1));
          if (j <= 0.001) return null;
          return (
            <span
              key={p.name}
              style={{
                position: "relative",
                zIndex: i === 0 ? 1 : 0,
                display: "inline-flex",
                borderRadius: "50%",
                border: `${u(2)}px solid ${COLORS.bgElevated}`,
                marginLeft: i === 0 ? 0 : -u(8) * j,
                boxShadow: i === 0 ? `0 0 0 ${u(2)}px #2dc06b` : undefined,
                transform: j < 1 ? `scale(${0.4 + 0.6 * j})` : undefined,
                opacity: Math.min(1, j * 1.6),
              }}
            >
              <UserAvatar person={p} size={u(24)} />
            </span>
          );
        })}
      </span>
    </div>
  );
};

/** The dock's tooltip bubble ("Invite people to edit together"), pointing down at the dock. */
export const InviteTooltip: React.FC<{ reveal?: number; text?: string }> = ({
  reveal = 1,
  text = "Invite people to edit together",
}) => {
  const { u } = useUi();
  if (reveal <= 0.001) return null;
  return (
    <div
      style={{
        position: "relative",
        display: "inline-block",
        padding: `${u(8)}px ${u(12)}px`,
        borderRadius: u(8),
        background: "#111214",
        border: `${u(1)}px solid ${COLORS.borderStrong}`,
        color: COLORS.text,
        fontFamily: INTER,
        fontSize: u(13),
        fontWeight: 600,
        whiteSpace: "nowrap",
        boxShadow: "0 12px 32px rgba(0,0,0,0.55)",
        opacity: Math.min(1, reveal),
        transform: reveal < 1 ? `translateY(${(1 - reveal) * u(6)}px)` : undefined,
      }}
    >
      {text}
      <span
        style={{
          position: "absolute",
          right: u(26),
          bottom: -u(6),
          width: u(10),
          height: u(10),
          background: "#111214",
          borderRight: `${u(1)}px solid ${COLORS.borderStrong}`,
          borderBottom: `${u(1)}px solid ${COLORS.borderStrong}`,
          transform: "rotate(45deg)",
        }}
      />
    </div>
  );
};

/**
 * The Activity as Discord hosts it on desktop: a rounded surface with the
 * Activity bar on top, the builder (left) and the preview (right), and the
 * presence dock pinned to the preview pane's bottom-right corner.
 */
export const ActivityShell: React.FC<{
  width: number;
  height: number;
  leftWidth?: number;
  bar: React.ReactNode;
  left: React.ReactNode;
  right: React.ReactNode;
  dock?: React.ReactNode;
  overlay?: React.ReactNode;
}> = ({ width, height, leftWidth = 520, bar, left, right, dock, overlay }) => {
  const { u } = useUi();
  return (
    <div
      style={{
        position: "relative",
        width,
        height,
        display: "flex",
        flexDirection: "column",
        borderRadius: 16,
        overflow: "hidden",
        background: COLORS.bg,
        border: `1px solid ${COLORS.borderStrong}`,
        boxShadow: "0 40px 120px rgba(0,0,0,0.6)",
        fontFamily: INTER,
      }}
    >
      {bar}
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <div style={{ width: leftWidth, flexShrink: 0, background: COLORS.bg, borderRight: `1px solid ${COLORS.border}`, position: "relative", overflow: "hidden", padding: u(10), boxSizing: "border-box" }}>
          {left}
        </div>
        <div style={{ flex: 1, minWidth: 0, position: "relative", background: COLORS.dBgPrimary, overflow: "hidden" }}>
          {right}
          {dock && <div style={{ position: "absolute", right: u(16), bottom: u(16) }}>{dock}</div>}
        </div>
      </div>
      {overlay}
    </div>
  );
};
