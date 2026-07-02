import React from "react";
import { interpolate } from "remotion";
import { COLORS } from "../theme";
import { INTER } from "../fonts";
import { Icon, IconName } from "./Icon";
import { Mascot } from "./Mascot";
import { AvatarDot } from "./Bits";

/* ── Window & layout ─────────────────────────────────────────────────────── */

/**
 * Browser chrome + the app's two-pane shell (builder left, preview right).
 * `overlay` renders last inside the window (which clips it), for docked panels
 * like the AI assistant, the plugin picker, or the Send popover.
 */
export const AppWindow: React.FC<{
  width: number;
  height: number;
  url?: string;
  left: React.ReactNode;
  right: React.ReactNode;
  leftWidth?: number;
  overlay?: React.ReactNode;
}> = ({ width, height, url = "dweeb.faizo.net", left, right, leftWidth = 560, overlay }) => (
  <div
    style={{
      width,
      height,
      background: COLORS.bgElevated,
      borderRadius: 18,
      overflow: "hidden",
      border: `1px solid ${COLORS.borderStrong}`,
      boxShadow: "0 40px 120px rgba(0,0,0,0.6)",
      display: "flex",
      flexDirection: "column",
      fontFamily: INTER,
      position: "relative",
    }}
  >
    <div
      style={{
        height: 44,
        background: COLORS.bgSubtle,
        borderBottom: `1px solid ${COLORS.border}`,
        display: "flex",
        alignItems: "center",
        padding: "0 16px",
        gap: 16,
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", gap: 8 }}>
        {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
          <div key={c} style={{ width: 12, height: 12, borderRadius: "50%", background: c }} />
        ))}
      </div>
      <div
        style={{
          flex: 1,
          maxWidth: 460,
          height: 27,
          background: COLORS.bgInput,
          borderRadius: 8,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 12px",
          fontSize: 13.5,
          color: COLORS.textMuted,
        }}
      >
        <Icon name="lock" size={14} color={COLORS.green} />
        {url}
      </div>
    </div>
    <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
      <div
        style={{
          width: leftWidth,
          flexShrink: 0,
          background: COLORS.bg,
          borderRight: `1px solid ${COLORS.border}`,
          display: "flex",
          flexDirection: "column",
          padding: 16,
          gap: 12,
          position: "relative",
        }}
      >
        {left}
      </div>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          background: COLORS.dBgPrimary,
          position: "relative",
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "center",
          padding: 26,
          overflow: "hidden",
        }}
      >
        {right}
      </div>
    </div>
    {overlay}
  </div>
);

/* ── Action bar (real labels from Builder.tsx) ───────────────────────────── */

const BarBtn: React.FC<{
  children?: React.ReactNode;
  icon?: IconName;
  primary?: boolean;
  glow?: boolean;
  chevron?: boolean;
}> = ({ children, icon, primary = false, glow = false, chevron = false }) => (
  <div
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 7,
      height: 34,
      padding: children ? "0 13px" : "0 9px",
      borderRadius: 9,
      background: primary ? COLORS.blurple : COLORS.bgInput,
      border: primary ? "none" : `1px solid ${COLORS.border}`,
      color: primary ? "#fff" : COLORS.text,
      fontFamily: INTER,
      fontSize: 14,
      fontWeight: 700,
      boxShadow: glow ? `0 0 24px ${primary ? COLORS.blurple : COLORS.green}88` : "none",
      whiteSpace: "nowrap",
    }}
  >
    {icon && <Icon name={icon} size={16} color="currentColor" />}
    {children}
    {chevron && <span style={{ fontSize: 10, opacity: 0.7 }}>▾</span>}
  </div>
);

export const ActionBar: React.FC<{
  sendLabel?: string;
  glowSend?: boolean;
  glowRestore?: boolean;
  glowMore?: boolean;
}> = ({ sendLabel = "Send", glowSend = false, glowRestore = false, glowMore = false }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
    <div
      style={{
        width: 34,
        height: 34,
        borderRadius: "50%",
        overflow: "hidden",
        background: COLORS.blurple,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <Mascot size={28} glow={false} look={false} />
    </div>
    <BarBtn icon="save">Saved</BarBtn>
    <BarBtn icon="history" />
    <div style={{ flex: 1 }} />
    <div style={{ position: "relative" }}>
      <BarBtn icon="link" chevron glow={glowMore}>
        More
      </BarBtn>
    </div>
    <BarBtn icon="refresh" glow={glowRestore}>
      Restore
    </BarBtn>
    <BarBtn icon={sendLabel === "Update" ? "pencil" : "send"} primary glow={glowSend}>
      {sendLabel}
    </BarBtn>
  </div>
);

/** Pane header — the real app has ONE Components pane (message identity lives
 *  inside it, at the bottom of the tree), so no tab row to switch. */
export const AppTabs: React.FC = () => (
  <div style={{ display: "flex", gap: 18, borderBottom: `1px solid ${COLORS.border}`, paddingBottom: 9 }}>
    <span
      style={{
        fontFamily: INTER,
        fontSize: 14.5,
        fontWeight: 700,
        color: COLORS.text,
        borderBottom: `2px solid ${COLORS.blurple}`,
        paddingBottom: 7,
        marginBottom: -10,
      }}
    >
      Components
    </span>
  </div>
);

/* ── Component tree ──────────────────────────────────────────────────────── */

export type TreeNodeDef = {
  icon: string;
  label: string;
  depth: number;
  sel?: boolean;
  issue?: boolean;
  chip?: string; // attached-plugin chip
  chipColor?: string;
  presence?: { name: string; color: string }[];
};

export const TreeRow: React.FC<TreeNodeDef & { reveal?: number }> = ({
  icon,
  label,
  depth,
  sel = false,
  issue = false,
  chip,
  chipColor = COLORS.blurple,
  presence,
  reveal = 1,
}) => {
  if (reveal <= 0.001) return null;
  return (
    <div
      style={{
        marginLeft: depth * 24,
        display: "flex",
        alignItems: "center",
        gap: 10,
        height: 42,
        padding: "0 12px",
        borderRadius: 10,
        background: sel ? COLORS.bgActive : COLORS.bgElevated,
        border: `1px solid ${sel ? COLORS.blurple : COLORS.border}`,
        color: COLORS.text,
        fontFamily: INTER,
        fontSize: 14.5,
        fontWeight: 600,
        opacity: reveal,
        transform: `translateX(${(1 - reveal) * -16}px)`,
        position: "relative",
      }}
    >
      <span style={{ color: sel ? COLORS.green : COLORS.textMuted, fontSize: 16, width: 20, textAlign: "center" }}>
        {icon}
      </span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      {chip && (
        <span
          style={{
            marginLeft: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            background: `${chipColor}22`,
            border: `1px solid ${chipColor}66`,
            color: COLORS.text,
            fontSize: 12,
            fontWeight: 700,
            padding: "2.5px 9px",
            borderRadius: 999,
          }}
        >
          <Icon name="plug" size={12} color={chipColor} />
          {chip}
        </span>
      )}
      {issue && (
        <span
          style={{
            marginLeft: chip ? 6 : "auto",
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: COLORS.warning,
            boxShadow: `0 0 10px ${COLORS.warning}`,
          }}
        />
      )}
      {presence && presence.length > 0 && (
        <div style={{ marginLeft: chip || issue ? 6 : "auto", display: "flex", gap: -6 }}>
          {presence.map((p, i) => (
            <div key={p.name} style={{ marginLeft: i === 0 ? 0 : -8 }}>
              <AvatarDot name={p.name} color={p.color} size={24} ring={p.color} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export const AddComponentBtn: React.FC<{ glow?: boolean }> = ({ glow = false }) => (
  <div
    style={{
      height: 42,
      borderRadius: 10,
      background: COLORS.blurple,
      color: "#fff",
      fontFamily: INTER,
      fontWeight: 700,
      fontSize: 14.5,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      boxShadow: glow ? `0 0 26px ${COLORS.blurple}99` : "none",
    }}
  >
    <Icon name="plus" size={16} color="#fff" />
    Add component
  </div>
);

/* ── Inspector ───────────────────────────────────────────────────────────── */

export const InspectorCard: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div
    style={{
      background: COLORS.bgElevated,
      border: `1px solid ${COLORS.border}`,
      borderRadius: 12,
      padding: 14,
      display: "flex",
      flexDirection: "column",
      gap: 11,
    }}
  >
    <div style={{ fontFamily: INTER, fontSize: 12.5, fontWeight: 800, letterSpacing: "0.05em", color: COLORS.textSubtle }}>
      {title.toUpperCase()}
    </div>
    {children}
  </div>
);

export const Field: React.FC<{ label: string; children: React.ReactNode; grow?: boolean }> = ({
  label,
  children,
  grow = false,
}) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: grow ? 1 : undefined }}>
    <span style={{ fontFamily: INTER, fontSize: 12.5, fontWeight: 700, color: COLORS.textMuted }}>{label}</span>
    <div
      style={{
        minHeight: 36,
        background: COLORS.bgInput,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 9,
        padding: "8px 11px",
        fontFamily: INTER,
        fontSize: 14,
        color: COLORS.text,
        display: "flex",
        alignItems: "center",
      }}
    >
      {children}
    </div>
  </div>
);

/* ── Floating issue pill (the consolidated header indicator) ─────────────── */

export const IssuePill: React.FC<{ count: number; reveal?: number; ok?: boolean }> = ({
  count,
  reveal = 1,
  ok = false,
}) => {
  if (reveal <= 0.01) return null;
  const color = ok ? COLORS.green : COLORS.warning;
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        background: `${color}1c`,
        border: `1px solid ${color}66`,
        borderRadius: 999,
        padding: "6px 14px",
        fontFamily: INTER,
        fontSize: 13.5,
        fontWeight: 700,
        color: COLORS.text,
        opacity: Math.min(1, reveal * 1.5),
        transform: `translateY(${(1 - reveal) * -10}px)`,
        boxShadow: `0 8px 30px rgba(0,0,0,0.35)`,
      }}
    >
      {ok ? (
        <Icon name="check" size={15} color={color} />
      ) : (
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: "50%",
            background: color,
            boxShadow: `0 0 10px ${color}`,
          }}
        />
      )}
      {ok ? "Ready to send" : `${count} issue${count === 1 ? "" : "s"}`}
    </div>
  );
};

/* ── Plugin library card ─────────────────────────────────────────────────── */

export const PluginCard: React.FC<{
  icon: IconName;
  color: string;
  name: string;
  desc: string;
  presets?: number;
  targets: string;
  added?: boolean;
  glow?: boolean;
}> = ({ icon, color, name, desc, presets, targets, added = false, glow = false }) => (
  <div
    style={{
      background: COLORS.bgElevated,
      border: `1px solid ${glow ? color : COLORS.border}`,
      borderRadius: 14,
      padding: 16,
      display: "flex",
      flexDirection: "column",
      gap: 9,
      fontFamily: INTER,
      boxShadow: glow ? `0 0 34px ${color}44` : "0 10px 30px rgba(0,0,0,0.3)",
      position: "relative",
      height: "100%",
    }}
  >
    <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: 11,
          background: `${color}22`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <Icon name={icon} size={23} color={color} />
      </div>
      <div style={{ fontWeight: 800, fontSize: 17.5, color: COLORS.text }}>{name}</div>
      {added && (
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 5, color: COLORS.green, fontSize: 13.5, fontWeight: 800 }}>
          <Icon name="check" size={16} color={COLORS.green} />
          Attached
        </div>
      )}
    </div>
    <div style={{ fontSize: 13.5, lineHeight: 1.42, color: COLORS.textMuted, flex: 1 }}>{desc}</div>
    <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
      <span
        style={{
          fontSize: 11.5,
          fontWeight: 700,
          color: COLORS.textMuted,
          background: COLORS.bgInput,
          border: `1px solid ${COLORS.border}`,
          padding: "3px 9px",
          borderRadius: 999,
        }}
      >
        {targets}
      </span>
      {presets != null && presets > 0 && (
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 700,
            color: COLORS.green,
            background: `${COLORS.green}14`,
            border: `1px solid ${COLORS.green}44`,
            padding: "3px 9px",
            borderRadius: 999,
          }}
        >
          {presets} presets
        </span>
      )}
    </div>
  </div>
);

/* ── Send panel rows (channel-first webhook picker) ──────────────────────── */

export const ChannelRow: React.FC<{
  name: string;
  note?: string;
  sel?: boolean;
  reveal?: number;
  badge?: string;
}> = ({ name, note, sel = false, reveal = 1, badge }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "11px 14px",
      borderRadius: 10,
      background: sel ? `${COLORS.blurple}1f` : COLORS.bgElevated,
      border: `1px solid ${sel ? COLORS.blurple : COLORS.border}`,
      fontFamily: INTER,
      opacity: interpolate(reveal, [0, 1], [0, 1]),
      transform: `translateY(${(1 - reveal) * 14}px)`,
    }}
  >
    <Icon name="hash" size={17} color={sel ? COLORS.blurple : COLORS.textMuted} />
    <span style={{ fontSize: 15.5, fontWeight: 700, color: COLORS.text }}>{name}</span>
    {badge && (
      <span
        style={{
          fontSize: 11.5,
          fontWeight: 800,
          color: COLORS.green,
          background: `${COLORS.green}16`,
          border: `1px solid ${COLORS.green}44`,
          padding: "2px 8px",
          borderRadius: 999,
        }}
      >
        {badge}
      </span>
    )}
    <span style={{ marginLeft: "auto", fontSize: 12.5, color: COLORS.textSubtle }}>{note}</span>
  </div>
);
