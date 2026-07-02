import React from "react";
import { COLORS } from "../theme";
import { INTER } from "../fonts";
import { Icon, IconName } from "./Icon";
import { Mascot } from "./Mascot";
import { AvatarDot } from "./Bits";

/* ── Discord app chrome ──────────────────────────────────────────────────── */

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

const ChannelIcon: React.FC<{ kind?: "text" | "voice" | "announcement"; locked?: boolean; color: string }> = ({
  kind = "text",
  locked,
  color,
}) => {
  if (locked) return <Icon name="lock" size={17} color={color} />;
  if (kind === "voice")
    return (
      <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round">
        <path d="M11 5.5L6.5 9H3.8v6h2.7L11 18.5z" fill={`${color}22`} />
        <path d="M15 9a4.2 4.2 0 0 1 0 6M17.7 6.8a8 8 0 0 1 0 10.4" />
      </svg>
    );
  if (kind === "announcement") return <Icon name="megaphone" size={17} color={color} />;
  return <Icon name="hash" size={17} color={color} />;
};

/**
 * The full Discord app frame: server rail, channel sidebar, chat header,
 * message area (children) and the message input. Everything fictional
 * ("Nebula Gaming") but structurally faithful.
 */
export const DiscordShell: React.FC<{
  width: number;
  height: number;
  serverName?: string;
  channels: Channel[];
  header: string;
  headerKind?: "text" | "voice" | "announcement";
  inputGhost?: string;
  children: React.ReactNode;
}> = ({
  width,
  height,
  serverName = "Nebula Gaming",
  channels,
  header,
  headerKind = "text",
  inputGhost = "Message #announcements",
  children,
}) => {
  return (
    <div
      style={{
        width,
        height,
        display: "flex",
        background: COLORS.dBgPrimary,
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
          background: COLORS.dBgTertiary,
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
            background: COLORS.dBgPrimary,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Mascot size={34} glow={false} look={false} />
        </div>
        <div style={{ width: 34, height: 2.5, background: COLORS.dDivider, borderRadius: 2 }} />
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 15,
            background: "linear-gradient(135deg, #7b5cff, #4752c4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            fontWeight: 800,
            fontSize: 19,
            boxShadow: "0 0 0 2.5px " + COLORS.dBgTertiary + ", 0 0 0 5px #ffffff55",
          }}
        >
          N
        </div>
        {["#23a559", "#f0b232", "#eb459e"].map((c, i) => (
          <div
            key={i}
            style={{
              width: 48,
              height: 48,
              borderRadius: 24,
              background: `${c}33`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: c,
              fontWeight: 800,
              fontSize: 18,
            }}
          >
            {["G", "S", "V"][i]}
          </div>
        ))}
      </div>

      {/* channel sidebar */}
      <div
        style={{
          width: 250,
          background: COLORS.dBgSecondary,
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
        }}
      >
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
          <span style={{ color: COLORS.dTextMuted, fontSize: 13 }}>▾</span>
        </div>
        <div style={{ padding: "12px 8px", display: "flex", flexDirection: "column", gap: 2 }}>
          {channels.map((c, i) => {
            if ("cat" in c)
              return (
                <div
                  key={`cat-${i}`}
                  style={{
                    padding: "10px 8px 4px",
                    fontSize: 12,
                    fontWeight: 800,
                    letterSpacing: "0.04em",
                    color: COLORS.dTextMuted,
                  }}
                >
                  {c.cat}
                </div>
              );
            const color = c.active ? "#fff" : c.unread ? COLORS.dText : COLORS.dChannel;
            const reveal = c.reveal ?? 1;
            if (reveal <= 0.001) return null;
            return (
              <div key={c.name} style={{ opacity: reveal, transform: `translateX(${(1 - reveal) * -14}px)` }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "7px 8px",
                    borderRadius: 6,
                    background: c.active ? "#404249" : "transparent",
                    color,
                    fontWeight: c.active || c.unread ? 650 : 500,
                    fontSize: 15.5,
                  }}
                >
                  <ChannelIcon kind={c.kind} locked={c.locked} color={c.active ? "#fff" : COLORS.dChannel} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                  {c.unread && (
                    <span style={{ marginLeft: "auto", width: 8, height: 8, borderRadius: 4, background: "#fff" }} />
                  )}
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
          <ChannelIcon kind={headerKind} color={COLORS.dTextMuted} />
          {header}
        </div>
        <div style={{ flex: 1, minHeight: 0, padding: "18px 22px", overflow: "hidden", position: "relative" }}>
          {children}
        </div>
        <div style={{ padding: "0 22px 20px", flexShrink: 0 }}>
          <div
            style={{
              height: 46,
              borderRadius: 10,
              background: COLORS.dInput,
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "0 16px",
              color: COLORS.dTextMuted,
              fontSize: 15.5,
            }}
          >
            <Icon name="plus" size={18} color={COLORS.dTextMuted} />
            {inputGhost}
          </div>
        </div>
      </div>
    </div>
  );
};

/* ── Messages & Components V2 blocks ─────────────────────────────────────── */

export const DMsg: React.FC<{
  author: string;
  time?: string;
  app?: boolean;
  avatarColor?: string;
  mascot?: boolean;
  edited?: boolean;
  ephemeral?: boolean;
  children: React.ReactNode;
}> = ({ author, time = "Today at 9:41 AM", app = true, avatarColor = COLORS.blurple, mascot = false, edited, ephemeral, children }) => (
  <div style={{ display: "flex", gap: 15, fontFamily: INTER, position: "relative" }}>
    {mascot ? (
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: "50%",
          overflow: "hidden",
          flexShrink: 0,
          background: COLORS.blurple,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Mascot size={40} glow={false} look={false} />
      </div>
    ) : (
      <AvatarDot name={author} color={avatarColor} size={44} />
    )}
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
        <span style={{ color: "#fff", fontWeight: 700, fontSize: 16.5 }}>{author}</span>
        {app && (
          <span
            style={{
              background: COLORS.blurple,
              color: "#fff",
              fontSize: 10.5,
              fontWeight: 800,
              padding: "1.5px 5px",
              borderRadius: 4,
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
            }}
          >
            ✓ APP
          </span>
        )}
        <span style={{ color: COLORS.dTextMuted, fontSize: 13 }}>{time}</span>
        {edited && <span style={{ color: COLORS.dTextMuted, fontSize: 11.5 }}>(edited)</span>}
      </div>
      {children}
      {ephemeral && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, color: COLORS.dTextMuted, fontSize: 13 }}>
          <Icon name="eye" size={14} color={COLORS.dTextMuted} />
          Only you can see this ·{" "}
          <span style={{ color: COLORS.dLink }}>Dismiss message</span>
        </div>
      )}
    </div>
  </div>
);

/** Components V2 container: accent bar + stacked child blocks on a card. */
export const DContainer: React.FC<{
  accent?: string;
  children: React.ReactNode;
  width?: number | string;
}> = ({ accent = COLORS.green, children, width = "100%" }) => (
  <div
    style={{
      display: "flex",
      gap: 0,
      background: COLORS.dBgSecondary,
      borderRadius: 10,
      overflow: "hidden",
      width,
      border: `1px solid ${COLORS.dBgTertiary}`,
    }}
  >
    <div style={{ width: 4, background: accent, flexShrink: 0 }} />
    <div style={{ flex: 1, minWidth: 0, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      {children}
    </div>
  </div>
);

export const DHeading: React.FC<{ icon?: IconName; iconColor?: string; children: React.ReactNode; size?: number }> = ({
  icon,
  iconColor = COLORS.green,
  children,
  size = 21,
}) => (
  <div style={{ color: "#fff", fontWeight: 800, fontSize: size, display: "flex", alignItems: "center", gap: 9, fontFamily: INTER }}>
    {icon && <Icon name={icon} size={size + 2} color={iconColor} />}
    {children}
  </div>
);

export const DBody: React.FC<{ children: React.ReactNode; muted?: boolean; size?: number }> = ({
  children,
  muted = false,
  size = 15.5,
}) => (
  <div style={{ color: muted ? COLORS.dTextMuted : COLORS.dText, fontSize: size, lineHeight: 1.45, fontFamily: INTER }}>
    {children}
  </div>
);

export const DMention: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span
    style={{
      background: COLORS.dMentionBg,
      color: COLORS.dMentionText,
      fontWeight: 600,
      borderRadius: 4,
      padding: "0 3px",
    }}
  >
    {children}
  </span>
);

export const DSep: React.FC = () => (
  <div style={{ height: 1, background: COLORS.dDivider, margin: "2px 0" }} />
);

/** Section: text on the left, an accessory (thumbnail or button) on the right. */
export const DSection: React.FC<{ children: React.ReactNode; accessory: React.ReactNode }> = ({
  children,
  accessory,
}) => (
  <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>{children}</div>
    <div style={{ flexShrink: 0 }}>{accessory}</div>
  </div>
);

export const MediaTile: React.FC<{
  from: string;
  to: string;
  w?: number | string;
  h?: number;
  label?: string;
  icon?: IconName;
  radius?: number;
}> = ({ from, to, w = "100%", h = 120, label, icon, radius = 8 }) => (
  <div
    style={{
      position: "relative",
      width: w,
      height: h,
      borderRadius: radius,
      background: `linear-gradient(135deg, ${from}, ${to})`,
      overflow: "hidden",
      flexShrink: 0,
    }}
  >
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "radial-gradient(120% 80% at 20% 10%, rgba(255,255,255,0.22), transparent 55%)",
      }}
    />
    {icon && (
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", opacity: 0.85 }}>
        <Icon name={icon} size={Math.min(46, h * 0.42)} color="#fff" />
      </div>
    )}
    {label && (
      <div
        style={{
          position: "absolute",
          top: 8,
          left: 8,
          fontFamily: INTER,
          fontSize: 11,
          fontWeight: 800,
          color: "rgba(255,255,255,0.9)",
          background: "rgba(0,0,0,0.42)",
          padding: "2px 7px",
          borderRadius: 5,
        }}
      >
        {label}
      </div>
    )}
  </div>
);

export const DGallery: React.FC<{ h?: number }> = ({ h = 150 }) => (
  <div style={{ display: "flex", gap: 8 }}>
    <div style={{ flex: 1.7, minWidth: 0, display: "flex" }}>
      <MediaTile from="#5865F2" to="#23a559" h={h} icon="rocket" />
    </div>
    <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1, minWidth: 0 }}>
      <MediaTile from="#f0b232" to="#f04747" h={(h - 8) / 2} />
      <MediaTile from="#00a8fc" to="#5865F2" h={(h - 8) / 2} />
    </div>
  </div>
);

export const DBtn: React.FC<{
  label: string;
  kind?: "primary" | "secondary" | "success" | "danger" | "link";
  emoji?: string;
  icon?: IconName;
  disabled?: boolean;
  glow?: boolean;
}> = ({ label, kind = "secondary", emoji, icon, disabled = false, glow = false }) => {
  const bg =
    kind === "primary"
      ? COLORS.dButtonPrimary
      : kind === "success"
        ? COLORS.dButtonSuccess
        : kind === "danger"
          ? COLORS.dButtonDanger
          : COLORS.dButtonSecondary;
  return (
    <div
      style={{
        background: bg,
        color: "#fff",
        fontFamily: INTER,
        fontWeight: 600,
        fontSize: 14.5,
        padding: "8px 15px",
        borderRadius: 8,
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        whiteSpace: "nowrap",
        opacity: disabled ? 0.45 : 1,
        boxShadow: glow ? `0 0 22px ${bg}aa` : "none",
      }}
    >
      {emoji && <span style={{ fontSize: 15 }}>{emoji}</span>}
      {icon && <Icon name={icon} size={16} color="#fff" />}
      {label}
      {kind === "link" && <Icon name="external" size={14} color={COLORS.dTextMuted} />}
    </div>
  );
};

export type SelectOption = { emoji: string; label: string; desc?: string; selected?: boolean };

/** String select. `openP` 0..1 reveals the options dropdown. */
export const DSelect: React.FC<{
  placeholder: string;
  options?: SelectOption[];
  openP?: number;
  width?: number | string;
  highlight?: number; // index the cursor is over
}> = ({ placeholder, options = [], openP = 0, width = "100%", highlight = -1 }) => (
  <div style={{ width, fontFamily: INTER, position: "relative" }}>
    <div
      style={{
        background: COLORS.dBgTertiary,
        border: `1px solid ${COLORS.dDivider}`,
        borderRadius: 8,
        padding: "10px 14px",
        color: COLORS.dText,
        fontSize: 15,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      {placeholder}
      <span style={{ color: COLORS.dTextMuted, transform: `rotate(${openP * 180}deg)`, display: "inline-block" }}>▾</span>
    </div>
    {openP > 0.02 && options.length > 0 && (
      <div
        style={{
          position: "absolute",
          top: "calc(100% + 6px)",
          left: 0,
          right: 0,
          background: COLORS.dBgTertiary,
          border: `1px solid ${COLORS.dDivider}`,
          borderRadius: 8,
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
              gap: 11,
              padding: "10px 14px",
              background: i === highlight ? "#36373d" : "transparent",
              borderBottom: i < options.length - 1 ? `1px solid ${COLORS.dDivider}55` : "none",
            }}
          >
            <span style={{ fontSize: 19 }}>{o.emoji}</span>
            <div style={{ flex: 1 }}>
              <div style={{ color: "#fff", fontWeight: 650, fontSize: 15 }}>{o.label}</div>
              {o.desc && <div style={{ color: COLORS.dTextMuted, fontSize: 13 }}>{o.desc}</div>}
            </div>
            <div
              style={{
                width: 19,
                height: 19,
                borderRadius: "50%",
                border: `2px solid ${o.selected ? COLORS.green : COLORS.dTextMuted}`,
                background: o.selected ? COLORS.green : "transparent",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 12,
                color: COLORS.dBgTertiary,
                fontWeight: 900,
              }}
            >
              {o.selected ? "✓" : ""}
            </div>
          </div>
        ))}
      </div>
    )}
  </div>
);

/* ── Context menu & modal ────────────────────────────────────────────────── */

export type MenuEntry = { label: string; icon?: IconName; sub?: boolean; hl?: boolean; danger?: boolean };

export const DContextMenu: React.FC<{
  x: number;
  y: number;
  entries: MenuEntry[];
  reveal?: number;
  width?: number;
}> = ({ x, y, entries, reveal = 1, width = 240 }) => {
  if (reveal <= 0.01) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width,
        background: "#111214",
        borderRadius: 9,
        padding: 7,
        border: `1px solid ${COLORS.dBgTertiary}`,
        boxShadow: "0 20px 60px rgba(0,0,0,0.65)",
        fontFamily: INTER,
        opacity: Math.min(1, reveal * 1.8),
        transform: `scale(${0.92 + reveal * 0.08})`,
        transformOrigin: "top left",
        zIndex: 20,
      }}
    >
      {entries.map((e) => (
        <div
          key={e.label}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "8px 10px",
            borderRadius: 5,
            background: e.hl ? COLORS.blurple : "transparent",
            color: e.danger ? "#fa777c" : e.hl ? "#fff" : COLORS.dText,
            fontSize: 14.5,
            fontWeight: 600,
          }}
        >
          {e.icon && <Icon name={e.icon} size={17} color="currentColor" />}
          <span style={{ flex: 1 }}>{e.label}</span>
          {e.sub && <span style={{ fontSize: 12, opacity: 0.8 }}>▸</span>}
        </div>
      ))}
    </div>
  );
};

/** Discord-style centered modal (used for intake forms / Modal Form plugin). */
export const DModal: React.FC<{
  title: string;
  subtitle?: string;
  reveal?: number;
  width?: number;
  submitLabel?: string;
  children: React.ReactNode;
}> = ({ title, subtitle, reveal = 1, width = 480, submitLabel = "Submit", children }) => {
  if (reveal <= 0.01) return null;
  return (
    <div
      style={{
        width,
        background: COLORS.dBgPrimary,
        borderRadius: 12,
        border: `1px solid ${COLORS.dBgTertiary}`,
        boxShadow: "0 40px 120px rgba(0,0,0,0.7)",
        fontFamily: INTER,
        opacity: Math.min(1, reveal * 1.6),
        transform: `scale(${0.9 + reveal * 0.1}) translateY(${(1 - reveal) * 18}px)`,
        overflow: "hidden",
      }}
    >
      <div style={{ padding: "18px 20px 4px" }}>
        <div style={{ color: "#fff", fontWeight: 800, fontSize: 19 }}>{title}</div>
        {subtitle && <div style={{ color: COLORS.dTextMuted, fontSize: 13.5, marginTop: 3 }}>{subtitle}</div>}
      </div>
      <div style={{ padding: "12px 20px 18px", display: "flex", flexDirection: "column", gap: 13 }}>{children}</div>
      <div
        style={{
          padding: "13px 20px",
          background: COLORS.dBgSecondary,
          display: "flex",
          justifyContent: "flex-end",
          gap: 12,
        }}
      >
        <span style={{ color: COLORS.dText, fontSize: 14.5, fontWeight: 600, padding: "9px 6px" }}>Cancel</span>
        <div
          style={{
            background: COLORS.dButtonPrimary,
            color: "#fff",
            fontWeight: 700,
            fontSize: 14.5,
            padding: "9px 22px",
            borderRadius: 7,
          }}
        >
          {submitLabel}
        </div>
      </div>
    </div>
  );
};

export const DField: React.FC<{ label: string; required?: boolean; children: React.ReactNode; h?: number }> = ({
  label,
  required = true,
  children,
  h = 40,
}) => (
  <div>
    <div style={{ color: COLORS.dTextMuted, fontSize: 12.5, fontWeight: 800, letterSpacing: "0.03em", marginBottom: 7 }}>
      {label.toUpperCase()}
      {required && <span style={{ color: "#fa777c" }}> *</span>}
    </div>
    <div
      style={{
        minHeight: h,
        background: COLORS.dBgTertiary,
        borderRadius: 6,
        padding: "9px 12px",
        color: COLORS.dText,
        fontSize: 15,
        display: "flex",
        alignItems: "flex-start",
      }}
    >
      {children}
    </div>
  </div>
);
