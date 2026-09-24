import React from "react";
import { COLORS } from "../../theme";
import { INTER } from "../../fonts";
import { withAlpha } from "../../lib/color";
import { CAST } from "../../story/campaign";
import { NebulaIcon, UserAvatar } from "./people";
import { PIcon, type ProductIconName } from "./ProductIcon";
import { useUi } from "./scale";
import { IconBtn } from "./chrome";

/**
 * The web builder's action bar (src/features/builder/Builder.tsx:569-857,
 * Builder.module.css): who you are + where the post lands on the left
 * (account composite · channel chip), then Save · Message directory · Restore
 * icons, "⋯" More, Undo/Redo, and the primary Send on the right.
 *
 * It keeps the product's collapse ladder: when the controls don't fit the
 * bar's width the row first tightens (no dividers, 30px More/Undo/Redo, 2px
 * gaps), then folds the utility icons into More one at a time from the END of
 * the list (Restore first). So a narrow pane — or the portrait stage — shows
 * exactly what the real app shows at that width. `actionBarPlan()` is that
 * decision; `actionBarAnchors()` gives every control's centre for the cursor.
 */

export type BarUtility = "save" | "directory" | "restore";
export type BarControl = "account" | "channel" | BarUtility | "more" | "undo" | "redo" | "send";

const UTILITY_ICON: Record<BarUtility, ProductIconName> = {
  save: "save",
  directory: "bookmark",
  restore: "history",
};

/**
 * Inter semibold advance widths by character class (em) — within a few px of
 * the real glyphs for the chip labels the film uses ("Pick a channel" ≈ 92px,
 * "announcements" ≈ 99px at 13px). Enough for the fit decision; if a guess is
 * short, the chip truncates its name exactly like the product does.
 */
export function textWidth(text: string, px: number): number {
  let em = 0;
  for (const ch of text) {
    if ("il.,:;'|!j".includes(ch)) em += 0.28;
    else if (" ftr()[]-/".includes(ch)) em += 0.36;
    else if ("mwMW".includes(ch)) em += 0.86;
    else if (/[A-Z]/.test(ch)) em += 0.68;
    else if (/[0-9]/.test(ch)) em += 0.6;
    else em += 0.57;
  }
  return em * px;
}
const textW = textWidth;

export type ActionBarPlan = {
  compact: boolean;
  utilities: BarUtility[];
  /** The last ladder step: Send drops its label (icon only). */
  sendIconOnly: boolean;
  /** Widths at k = 1 of every control actually shown, left→right. */
  widths: { id: BarControl | "sep"; w: number }[];
  padX: number;
  groupGap: number;
  rightGap: number;
  leftGap: number;
};

const ACCOUNT_W = 54; // 3 + 30 avatar + 3 + 14 chevron + 4
const SEND_W = { Send: 80, Update: 90 } as const;
/** Send with its label hidden: 12 + 16 icon + 12. */
const SEND_ICON_W = 40;
/**
 * The product's fit check reserves a readable minimum for the channel chip;
 * this slack stands in for it (and for text-width estimation error), so the
 * ladder folds a step early rather than truncating the channel name.
 */
const FIT_SLACK = 4;

export function actionBarPlan(
  widthPx: number,
  k: number,
  opts: { channel?: string | null; sendLabel?: "Send" | "Update"; utilities?: BarUtility[]; forceCompact?: boolean } = {},
): ActionBarPlan {
  const all = opts.utilities ?? (["save", "directory", "restore"] as BarUtility[]);
  const chipText = opts.channel ?? "Pick a channel";
  // 1px transparent border each side + 8 padding + 16 icon + 4 + text + 4 + 14 chevron + 8.
  const chipW = 2 + 8 + 16 + 4 + textW(chipText, 13) + 4 + 14 + 8;
  const available = widthPx / k - FIT_SLACK;
  const build = (compact: boolean, utilities: BarUtility[], sendIconOnly = false): ActionBarPlan => {
    const small = compact ? 30 : 36;
    const right: ActionBarPlan["widths"] = [
      ...utilities.map((u) => ({ id: u as BarControl, w: 36 })),
      { id: "more", w: small },
      ...(compact ? [] : [{ id: "sep" as const, w: 9 }]),
      { id: "undo", w: small },
      { id: "redo", w: small },
      ...(compact ? [] : [{ id: "sep" as const, w: 9 }]),
      { id: "send", w: sendIconOnly ? SEND_ICON_W : SEND_W[opts.sendLabel ?? "Send"] },
    ];
    return {
      compact,
      utilities,
      sendIconOnly,
      widths: [{ id: "account", w: ACCOUNT_W }, { id: "channel", w: chipW }, ...right],
      padX: compact ? 8 : 12,
      groupGap: compact ? 8 : 12,
      rightGap: compact ? 2 : 4,
      leftGap: compact ? 2 : 8,
    };
  };
  const need = (p: ActionBarPlan) => {
    const right = p.widths.slice(2);
    return (
      p.padX * 2 +
      ACCOUNT_W +
      p.leftGap +
      chipW +
      p.groupGap +
      right.reduce((s, x) => s + x.w, 0) +
      p.rightGap * (right.length - 1)
    );
  };
  if (!opts.forceCompact) {
    const full = build(false, all);
    if (need(full) <= available) return full;
  }
  // Tighten, then fold the utilities from the end of the list one at a time…
  for (let n = all.length; n >= 0; n--) {
    const p = build(true, all.slice(0, n));
    if (need(p) <= available) return p;
  }
  // …and finally drop the Send label (the chip truncates past this point).
  return build(true, [], true);
}

/** Centre of each visible control, relative to the bar's top-left (world px). */
export function actionBarAnchors(plan: ActionBarPlan, widthPx: number, k: number, heightPx = 52 * k) {
  const out: Partial<Record<BarControl, { x: number; y: number }>> = {};
  const cy = heightPx / 2;
  // Right cluster, laid from the right edge.
  let x = widthPx - plan.padX * k;
  const right = plan.widths.slice(2);
  for (let i = right.length - 1; i >= 0; i--) {
    const it = right[i];
    const w = it.w * k;
    if (it.id !== "sep") out[it.id] = { x: x - w / 2, y: cy };
    x -= w + (i > 0 ? plan.rightGap * k : 0);
  }
  const left = plan.padX * k;
  out.account = { x: left + (ACCOUNT_W * k) / 2, y: cy };
  out.channel = { x: left + ACCOUNT_W * k + plan.leftGap * k + (plan.widths[1].w * k) / 2, y: cy };
  return out;
}

/** Account control when signed in with a server connected: server icon + your avatar badge + chevron. */
export const AccountComposite: React.FC<{ hover?: boolean }> = ({ hover }) => {
  const { u } = useUi();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: u(3),
        height: u(36),
        padding: `0 ${u(4)}px 0 ${u(3)}px`,
        borderRadius: u(6),
        background: hover ? COLORS.bgHover : "transparent",
        flexShrink: 0,
      }}
    >
      <div style={{ position: "relative", width: u(30), height: u(30) }}>
        <NebulaIcon size={u(30)} shape="rounded" />
        <UserAvatar
          person={CAST.aria}
          size={u(18)}
          style={{
            position: "absolute",
            right: -u(3),
            bottom: -u(3),
            border: `${u(2)}px solid ${COLORS.bgElevated}`,
          }}
        />
      </div>
      <PIcon name="chevronDown" size={u(14)} color={COLORS.textSubtle} />
    </div>
  );
};

/** The destination chip (ChannelPicker trigger): "# announcements ▾" or "# Pick a channel ▾". */
export const ChannelChip: React.FC<{ channel?: string | null; open?: boolean; hover?: boolean; glow?: number }> = ({
  channel = null,
  open = false,
  hover = false,
  glow = 0,
}) => {
  const { u } = useUi();
  const active = open || hover;
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: u(4),
        height: u(30),
        boxSizing: "border-box",
        padding: `0 ${u(8)}px`,
        borderRadius: u(6),
        border: `${u(1)}px solid ${active ? COLORS.border : "transparent"}`,
        background: active ? COLORS.bgSubtle : "transparent",
        color: channel ? COLORS.text : COLORS.textMuted,
        fontFamily: INTER,
        fontSize: u(13),
        fontWeight: 600,
        whiteSpace: "nowrap",
        minWidth: 0,
        boxShadow:
          glow > 0.01 ? `0 0 0 ${u(2)}px ${withAlpha(COLORS.green, 0.8 * glow)}, 0 0 ${u(18)}px ${withAlpha(COLORS.green, 0.45 * glow)}` : undefined,
      }}
    >
      <PIcon name="hash" size={u(16)} color={COLORS.textSubtle} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{channel ?? "Pick a channel"}</span>
      <PIcon name="chevronDown" size={u(14)} color={COLORS.textSubtle} />
    </div>
  );
};

const Sep: React.FC = () => {
  const { u } = useUi();
  return <span style={{ width: 1, alignSelf: "stretch", margin: `${u(8)}px ${u(4)}px`, background: COLORS.border, flexShrink: 0 }} />;
};

export type EditorActionBarProps = {
  /** The bar's width in px (world) — drives the collapse ladder. */
  width: number;
  /** Destination channel; null = the chip's empty "Pick a channel" state. */
  channel?: string | null;
  sendLabel?: "Send" | "Update";
  /** Utilities allowed inline (the ladder may fold some into More). */
  utilities?: BarUtility[];
  forceCompact?: boolean;
  hover?: BarControl | null;
  pressed?: BarControl | null;
  /** 0..1 attention glow per control. */
  glow?: Partial<Record<BarControl, number>>;
  channelOpen?: boolean;
  canUndo?: boolean;
  canRedo?: boolean;
};

/** The bar itself: full-width, 52px (×k), elevated with a bottom hairline. */
export const EditorActionBar: React.FC<EditorActionBarProps> = ({
  width,
  channel = null,
  sendLabel = "Send",
  utilities,
  forceCompact,
  hover = null,
  pressed = null,
  glow = {},
  channelOpen = false,
  canUndo = true,
  canRedo = false,
}) => {
  const { k, u } = useUi();
  const plan = actionBarPlan(width, k, { channel, sendLabel, utilities, forceCompact });
  const iconSize = plan.compact ? "sm" : "md";
  return (
    <div
      style={{
        width,
        height: u(52),
        boxSizing: "border-box",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: u(plan.groupGap),
        padding: `0 ${u(plan.padX)}px`,
        background: COLORS.bgElevated,
        borderBottom: `${u(1)}px solid ${COLORS.border}`,
        fontFamily: INTER,
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: u(plan.leftGap), minWidth: 0 }}>
        <AccountComposite hover={hover === "account"} />
        <ChannelChip channel={channel} open={channelOpen} hover={hover === "channel"} glow={glow.channel} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: u(plan.rightGap), flexShrink: 0 }}>
        {plan.utilities.map((ut) => (
          <IconBtn
            key={ut}
            name={UTILITY_ICON[ut]}
            hover={hover === ut}
            pressed={pressed === ut}
            glow={glow[ut]}
          />
        ))}
        <IconBtn name="moreHorizontal" size={iconSize} hover={hover === "more"} pressed={pressed === "more"} glow={glow.more} />
        {!plan.compact && <Sep />}
        <IconBtn name="undo" size={iconSize} hover={hover === "undo"} pressed={pressed === "undo"} disabled={!canUndo} glow={glow.undo} />
        <IconBtn name="redo" size={iconSize} hover={hover === "redo"} pressed={pressed === "redo"} disabled={!canRedo} glow={glow.redo} />
        {!plan.compact && <Sep />}
        <SendButton label={sendLabel} iconOnly={plan.sendIconOnly} hover={hover === "send"} pressed={pressed === "send"} glow={glow.send} />
      </div>
    </div>
  );
};

/** The primary Send (Button sm, leading paper plane); Update swaps the icon. Fixed width so anchors are exact. */
export const SendButton: React.FC<{
  label?: "Send" | "Update" | "Post";
  /** The bar's last collapse step: the label is dropped, the icon stays. */
  iconOnly?: boolean;
  hover?: boolean;
  pressed?: boolean;
  glow?: number;
}> = ({ label = "Send", iconOnly = false, hover, pressed, glow = 0 }) => {
  const { u } = useUi();
  const w = iconOnly ? SEND_ICON_W : label === "Update" ? SEND_W.Update : SEND_W.Send;
  return (
    <div
      style={{
        width: u(w),
        height: u(32),
        boxSizing: "border-box",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: u(8),
        borderRadius: u(6),
        background: hover || pressed ? COLORS.blurpleHover : COLORS.blurple,
        color: "#fff",
        fontFamily: INTER,
        fontWeight: 600,
        fontSize: u(13),
        flexShrink: 0,
        transform: pressed ? "scale(0.96)" : undefined,
        boxShadow:
          glow > 0.01
            ? `0 0 0 ${u(2)}px ${withAlpha("#8e98ff", 0.85 * glow)}, 0 0 ${u(26)}px ${withAlpha(COLORS.blurple, 0.7 * glow)}`
            : undefined,
      }}
    >
      <PIcon name={label === "Update" ? "refresh" : "send"} size={u(16)} />
      {!iconOnly && label}
    </div>
  );
};
