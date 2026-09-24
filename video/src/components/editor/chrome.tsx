import React from "react";
import { COLORS } from "../../theme";
import { INTER } from "../../fonts";
import { withAlpha } from "../../lib/color";
import { PIcon, type ProductIconName } from "./ProductIcon";
import { useUi } from "./scale";

/**
 * App-chrome atoms at the product's metrics (src/ui/*.module.css), scaled by
 * UiScale: Button, IconButton, the Modal card (and its portrait bottom-sheet
 * form), the backdrop, the toast, and form fields.
 */

/* ── Buttons ────────────────────────────────────────────────────────────── */

export type AppButtonVariant = "primary" | "secondary" | "ghost";

/** ui/Button: sm = 32px/13px, md = 36px/14px; primary blurple, secondary input-grey. */
export const AppButton: React.FC<{
  variant?: AppButtonVariant;
  size?: "sm" | "md";
  icon?: ProductIconName;
  children?: React.ReactNode;
  hover?: boolean;
  pressed?: boolean;
  /** 0..1 attention glow. */
  glow?: number;
  width?: number;
  style?: React.CSSProperties;
}> = ({ variant = "secondary", size = "sm", icon, children, hover, pressed, glow = 0, width, style }) => {
  const { u } = useUi();
  const bg =
    variant === "primary"
      ? hover || pressed
        ? COLORS.blurpleHover
        : COLORS.blurple
      : variant === "secondary"
        ? hover || pressed
          ? COLORS.bgHover
          : COLORS.bgInput
        : hover || pressed
          ? COLORS.bgHover
          : "transparent";
  const ink = variant === "primary" ? "#fff" : variant === "secondary" ? COLORS.text : hover ? COLORS.text : COLORS.textMuted;
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: u(8),
        height: u(size === "sm" ? 32 : 36),
        width,
        boxSizing: "border-box",
        padding: `0 ${u(size === "sm" ? 12 : 16)}px`,
        borderRadius: u(6),
        border: `${u(1)}px solid ${variant === "secondary" ? (hover ? COLORS.borderStrong : COLORS.border) : "transparent"}`,
        background: bg,
        color: ink,
        fontFamily: INTER,
        fontWeight: 600,
        fontSize: u(size === "sm" ? 13 : 14),
        whiteSpace: "nowrap",
        flexShrink: 0,
        transform: pressed ? "scale(0.96)" : undefined,
        boxShadow:
          glow > 0.01
            ? `0 0 0 ${u(2)}px ${withAlpha(variant === "primary" ? "#8e98ff" : COLORS.green, 0.8 * glow)}, 0 0 ${u(24)}px ${withAlpha(variant === "primary" ? COLORS.blurple : COLORS.green, 0.6 * glow)}`
            : undefined,
        ...style,
      }}
    >
      {icon && <PIcon name={icon} size={u(16)} />}
      {children}
    </div>
  );
};

/** ui/IconButton: md 36 / sm 30 square, muted ink; hover fills bg-hover. */
export const IconBtn: React.FC<{
  name: ProductIconName;
  size?: "sm" | "md";
  hover?: boolean;
  pressed?: boolean;
  disabled?: boolean;
  /** 0..1 attention ring (e.g. the icon a cursor is about to click). */
  glow?: number;
  iconSize?: number;
}> = ({ name, size = "md", hover, pressed, disabled, glow = 0, iconSize = 16 }) => {
  const { u } = useUi();
  const box = u(size === "md" ? 36 : 30);
  return (
    <div
      style={{
        width: box,
        height: box,
        flexShrink: 0,
        borderRadius: u(6),
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: hover || pressed ? COLORS.bgHover : "transparent",
        color: hover || pressed ? COLORS.text : COLORS.textMuted,
        opacity: disabled ? 0.4 : 1,
        transform: pressed ? "scale(0.92)" : undefined,
        boxShadow:
          glow > 0.01 ? `0 0 0 ${u(2)}px ${withAlpha(COLORS.blurple, 0.9 * glow)}, 0 0 ${u(16)}px ${withAlpha(COLORS.blurple, 0.5 * glow)}` : undefined,
      }}
    >
      <PIcon name={name} size={u(iconSize)} />
    </div>
  );
};

/* ── Modal card / bottom sheet ──────────────────────────────────────────── */

/**
 * ui/Modal's dialog: elevated card, 14px radius, 16/20 header with a 15px/700
 * title and a close button, 20px body with 16px gaps. `sheet` renders the same
 * content as a portrait bottom sheet (grabber, square bottom). `reveal` 0..1
 * rises it in; its shadow scales with it.
 */
export const ModalCard: React.FC<{
  title: string;
  titleIcon?: React.ReactNode;
  width?: number | string;
  height?: number | string;
  reveal?: number;
  sheet?: boolean;
  headerExtra?: React.ReactNode;
  footer?: React.ReactNode;
  bodyGap?: number;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ title, titleIcon, width = "100%", height, reveal = 1, sheet = false, headerExtra, footer, bodyGap = 16, children, style }) => {
  const { u } = useUi();
  if (reveal <= 0.001) return null;
  const r = Math.min(1, reveal);
  return (
    <div
      style={{
        width,
        height,
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        background: COLORS.bgElevated,
        border: `${u(1)}px solid ${COLORS.border}`,
        borderBottom: sheet ? "none" : undefined,
        borderRadius: sheet ? `${u(18)}px ${u(18)}px 0 0` : u(14),
        boxShadow: `0 ${u(16)}px ${u(48)}px rgba(0,0,0,${(0.6 * r).toFixed(3)})`,
        overflow: "hidden",
        fontFamily: INTER,
        color: COLORS.text,
        opacity: sheet ? 1 : Math.min(1, r * 1.6),
        transform: r < 1 ? (sheet ? `translateY(${(1 - r) * 100}%)` : `translateY(${(1 - r) * u(14)}px) scale(${0.97 + r * 0.03})`) : undefined,
        ...style,
      }}
    >
      {sheet && (
        <div style={{ display: "flex", justifyContent: "center", paddingTop: u(8) }}>
          <div style={{ width: u(40), height: u(5), borderRadius: 3, background: COLORS.borderStrong }} />
        </div>
      )}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: u(10),
          padding: sheet ? `${u(8)}px ${u(16)}px ${u(12)}px` : `${u(16)}px ${u(20)}px`,
          borderBottom: `${u(1)}px solid ${COLORS.border}`,
          flexShrink: 0,
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: u(9), fontSize: u(15), fontWeight: 700 }}>
          {titleIcon}
          {title}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: u(4) }}>
          {headerExtra}
          <span
            style={{
              width: u(32),
              height: u(32),
              borderRadius: u(6),
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: COLORS.textMuted,
            }}
          >
            <PIcon name="close" size={u(18)} />
          </span>
        </span>
      </div>
      <div
        style={{
          padding: sheet ? `${u(14)}px ${u(16)}px` : u(20),
          display: "flex",
          flexDirection: "column",
          gap: u(bodyGap),
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        {children}
      </div>
      {footer}
    </div>
  );
};

/** The modal scrim (rgba(0,0,0,.6)), fading with `reveal`. Fills its parent. */
export const Backdrop: React.FC<{ reveal?: number; children?: React.ReactNode; style?: React.CSSProperties }> = ({
  reveal = 1,
  children,
  style,
}) =>
  reveal <= 0.001 ? null : (
    <div style={{ position: "absolute", inset: 0, background: `rgba(0,0,0,${(0.6 * Math.min(1, reveal)).toFixed(3)})`, ...style }}>
      {children}
    </div>
  );

/* ── Toast ──────────────────────────────────────────────────────────────── */

/** ui/Toast: elevated card, tone badge, message, dismiss ✕. `reveal` slides it in. */
export const AppToast: React.FC<{
  message: React.ReactNode;
  tone?: "success" | "info";
  reveal?: number;
  maxWidth?: number;
  action?: string;
}> = ({ message, tone = "success", reveal = 1, maxWidth = 360, action }) => {
  const { u } = useUi();
  if (reveal <= 0.001) return null;
  const r = Math.min(1, reveal);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: u(12),
        padding: `${u(12)}px ${u(8)}px ${u(12)}px ${u(12)}px`,
        borderRadius: u(14),
        border: `${u(1)}px solid ${COLORS.border}`,
        background: COLORS.bgElevated,
        color: COLORS.text,
        fontFamily: INTER,
        fontSize: u(13),
        fontWeight: 500,
        lineHeight: 1.4,
        boxShadow: `0 ${u(16)}px ${u(48)}px rgba(0,0,0,${(0.6 * r).toFixed(3)})`,
        minWidth: u(220),
        maxWidth: u(maxWidth),
        boxSizing: "border-box",
        opacity: r,
        transform: r < 1 ? `translateY(${(1 - r) * -u(10)}px) scale(${0.96 + r * 0.04})` : undefined,
      }}
    >
      <span
        style={{
          width: u(28),
          height: u(28),
          borderRadius: 999,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: tone === "success" ? "rgba(45,192,107,0.14)" : "rgba(88,101,242,0.18)",
          color: tone === "success" ? "#6ddf9e" : "#aeb6ff",
        }}
      >
        <PIcon name={tone === "success" ? "checkCircle" : "info"} size={u(16)} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>{message}</span>
      {action && (
        <span
          style={{
            padding: `${u(6)}px ${u(10)}px`,
            borderRadius: u(6),
            fontWeight: 600,
            color: "#aeb6ff",
            background: "rgba(88,101,242,0.18)",
          }}
        >
          {action}
        </span>
      )}
      <span style={{ width: u(32), height: u(32), display: "flex", alignItems: "center", justifyContent: "center", color: COLORS.textSubtle }}>
        <PIcon name="close" size={u(16)} />
      </span>
    </div>
  );
};

/* ── Fields ─────────────────────────────────────────────────────────────── */

/** ui/Field label (13px/600) with an optional right-aligned count. */
export const FieldLabel: React.FC<{ label: string; count?: string }> = ({ label, count }) => {
  const { u } = useUi();
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: u(8), lineHeight: `${u(18)}px`, height: u(18) }}>
      <span style={{ fontSize: u(13), fontWeight: 600, color: COLORS.text }}>{label}</span>
      {count && <span style={{ fontSize: u(12), color: COLORS.textSubtle, fontVariantNumeric: "tabular-nums" }}>{count}</span>}
    </div>
  );
};

/** ui/TextInput / Select box: 36px, input-grey, 6px radius; `select` adds the chevron. */
export const InputBox: React.FC<{
  value: React.ReactNode;
  placeholder?: boolean;
  select?: boolean;
  focused?: boolean;
  style?: React.CSSProperties;
}> = ({ value, placeholder, select, focused, style }) => {
  const { u } = useUi();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: u(8),
        minHeight: u(36),
        boxSizing: "border-box",
        padding: `0 ${u(12)}px`,
        borderRadius: u(6),
        background: focused ? COLORS.bgActive : COLORS.bgInput,
        border: `${u(1)}px solid ${focused ? COLORS.blurple : COLORS.border}`,
        boxShadow: focused ? `0 0 0 ${u(2)}px ${COLORS.blurple}` : undefined,
        fontSize: u(14),
        color: placeholder ? COLORS.textSubtle : COLORS.text,
        fontFamily: INTER,
        whiteSpace: "nowrap",
        overflow: "hidden",
        ...style,
      }}
    >
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{value}</span>
      {select && <PIcon name="chevronDown" size={u(14)} color={COLORS.textMuted} />}
    </div>
  );
};
