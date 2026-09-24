import React from "react";
import { COLORS } from "../../theme";
import { INTER } from "../../fonts";
import { mixColor, withAlpha } from "../../lib/color";
import { LIMITS, statPillText } from "../../story/rules";
import { AUTHOR, AVATAR_TOKEN } from "../../story/campaign";
import { PIcon } from "./ProductIcon";
import { useUi } from "./scale";
import { FieldLabel, InputBox } from "./chrome";

/**
 * The tree's MetaHeader (ComponentTree.tsx:510-575): the webhook identity
 * fields, the message options card, and the two budget pills
 * "n / 40 components" and "n / 4000 chars" — the always-visible evidence that
 * every limit is checked. The film adds one flourish the VO calls for: `ok`
 * flashes both pills green with a check ("…and every limit is checked").
 */

/** One budget pill (StatPill: 12px/600, subtle fill, hairline, pill radius). */
export const StatPill: React.FC<{
  value: number;
  max: number;
  singular: string;
  plural: string;
  /** 0..1 green "checked" state. */
  ok?: number;
  /** 0..1 bump when the number just changed. */
  tick?: number;
}> = ({ value, max, singular, plural, ok = 0, tick = 0 }) => {
  const { u } = useUi();
  const g = Math.max(0, Math.min(1, ok));
  const near = value / max >= 0.85;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: u(5),
        height: u(24),
        boxSizing: "border-box",
        padding: `0 ${u(9)}px`,
        borderRadius: 999,
        fontFamily: INTER,
        fontSize: u(12),
        fontWeight: 600,
        whiteSpace: "nowrap",
        fontVariantNumeric: "tabular-nums",
        color: g > 0 ? mixColor(COLORS.textMuted, "#6ddf9e", g) : near ? "#f7cb6b" : COLORS.textMuted,
        background: g > 0 ? mixColor(COLORS.bgSubtle, "rgba(45,192,107,0.16)", g) : COLORS.bgSubtle,
        border: `${u(1)}px solid ${g > 0 ? mixColor(COLORS.border, "rgba(45,192,107,0.55)", g) : COLORS.border}`,
        boxShadow: g > 0.01 ? `0 0 ${u(16)}px ${withAlpha("#2dc06b", 0.35 * g)}` : undefined,
        transform: tick > 0.01 ? `scale(${1 + 0.08 * Math.sin(Math.min(1, tick) * Math.PI)})` : undefined,
      }}
    >
      {g > 0.02 && (
        <span style={{ display: "flex", width: u(14) * Math.min(1, g * 1.5), overflow: "hidden" }}>
          <PIcon name="checkCircle" size={u(14)} color="#6ddf9e" strokeWidth={2} />
        </span>
      )}
      {statPillText(value, max, singular, plural)}
    </span>
  );
};

export const StatPills: React.FC<{
  components: number;
  chars: number;
  ok?: number;
  tick?: { components?: number; chars?: number };
}> = ({ components, chars, ok = 0, tick = {} }) => {
  const { u } = useUi();
  return (
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: u(6) }}>
      <StatPill value={components} max={LIMITS.TOTAL_COMPONENTS} singular="component" plural="components" ok={ok} tick={tick.components} />
      <StatPill value={chars} max={LIMITS.TOTAL_CHARACTERS} singular="char" plural="chars" ok={ok} tick={tick.chars} />
    </div>
  );
};

/**
 * The header above the tree. `fields` shows Username / Avatar URL (the reason
 * the preview's author reads "Nebula Gaming" with the server's icon);
 * `options` the Notifications / Forum post card. The pills always show.
 */
export const MetaHeader: React.FC<{
  components: number;
  chars: number;
  ok?: number;
  tick?: { components?: number; chars?: number };
  fields?: boolean;
  options?: boolean;
}> = ({ components, chars, ok, tick, fields = false, options = false }) => {
  const { u } = useUi();
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: u(12),
        padding: `${u(8)}px ${u(4)}px ${u(16)}px`,
        borderBottom: `${u(1)}px solid ${COLORS.border}`,
        marginBottom: u(12),
        fontFamily: INTER,
      }}
    >
      {fields && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: u(12) }}>
          <div style={{ display: "flex", flexDirection: "column", gap: u(6) }}>
            <FieldLabel label="Username" />
            <InputBox value={AUTHOR} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: u(6) }}>
            <FieldLabel label="Avatar URL" />
            <InputBox value={AVATAR_TOKEN} />
          </div>
        </div>
      )}
      {options && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            height: u(52),
            boxSizing: "border-box",
            border: `${u(1)}px solid ${COLORS.border}`,
            borderRadius: u(10),
            background: COLORS.bgSubtle,
          }}
        >
          {[
            { icon: "bell" as const, title: "Notifications", sub: "Silent send & who gets pinged" },
            { icon: "forum" as const, title: "Forum post", sub: "Thread name & tags" },
          ].map((o, i) => (
            <div
              key={o.title}
              style={{
                display: "flex",
                alignItems: "center",
                gap: u(10),
                padding: `${u(10)}px ${u(12)}px`,
                borderLeft: i === 1 ? `${u(1)}px solid ${COLORS.border}` : undefined,
                minWidth: 0,
              }}
            >
              <span
                style={{
                  width: u(30),
                  height: u(30),
                  borderRadius: u(8),
                  border: `${u(1)}px solid ${COLORS.border}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: COLORS.textMuted,
                  flexShrink: 0,
                }}
              >
                <PIcon name={o.icon} size={u(16)} />
              </span>
              <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                <span style={{ fontSize: u(13), fontWeight: 600, color: COLORS.text }}>{o.title}</span>
                <span style={{ fontSize: u(12), color: COLORS.textMuted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {o.sub}
                </span>
              </span>
              <span style={{ marginLeft: "auto", color: COLORS.textSubtle, display: "flex" }}>
                <PIcon name="chevronRight" size={u(14)} />
              </span>
            </div>
          ))}
        </div>
      )}
      <StatPills components={components} chars={chars} ok={ok} tick={tick} />
    </div>
  );
};

