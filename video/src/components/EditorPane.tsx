import React from "react";
import { COLORS } from "../theme";
import { INTER } from "../fonts";

type Node = { icon: string; label: string; depth: number; accent?: boolean };

const NODES: Node[] = [
  { icon: "▤", label: "Container", depth: 0 },
  { icon: "◧", label: "Section", depth: 1 },
  { icon: "¶", label: "Text", depth: 2 },
  { icon: "▦", label: "Media Gallery", depth: 1 },
  { icon: "⬚", label: "Buttons Row", depth: 1, accent: true },
];

const PILL: React.FC<{ children: React.ReactNode; bg?: string }> = ({ children, bg }) => (
  <div
    style={{
      height: 30,
      padding: "0 12px",
      borderRadius: 8,
      background: bg ?? COLORS.bgInput,
      color: COLORS.text,
      fontFamily: INTER,
      fontSize: 13,
      fontWeight: 600,
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
    }}
  >
    {children}
  </div>
);

/**
 * The DWEEB editor's left pane: action bar + the component tree. `revealed`
 * controls how many tree nodes have dropped in (for the build animation).
 */
export const EditorPane: React.FC<{ revealed?: number }> = ({ revealed = NODES.length }) => {
  return (
    <div
      style={{
        height: "100%",
        background: COLORS.bg,
        display: "flex",
        flexDirection: "column",
        padding: 18,
        gap: 14,
      }}
    >
      {/* action bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <PILL>↶</PILL>
        <PILL>↷</PILL>
        <div style={{ flex: 1 }} />
        <PILL>Share</PILL>
        <PILL bg={COLORS.blurple}>Send ▸</PILL>
      </div>

      {/* tabs */}
      <div style={{ display: "flex", gap: 18, borderBottom: `1px solid ${COLORS.border}`, paddingBottom: 8 }}>
        <span style={{ fontFamily: INTER, fontSize: 14, fontWeight: 700, color: COLORS.text }}>
          Components
        </span>
        <span style={{ fontFamily: INTER, fontSize: 14, fontWeight: 600, color: COLORS.textSubtle }}>
          Message
        </span>
      </div>

      {/* tree */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
        {NODES.map((n, i) => {
          const on = i < revealed;
          return (
            <div
              key={i}
              style={{
                marginLeft: n.depth * 22,
                display: "flex",
                alignItems: "center",
                gap: 10,
                height: 40,
                padding: "0 12px",
                borderRadius: 10,
                background: n.accent && on ? COLORS.bgActive : COLORS.bgElevated,
                border: `1px solid ${n.accent && on ? COLORS.borderStrong : COLORS.border}`,
                color: COLORS.text,
                fontFamily: INTER,
                fontSize: 14.5,
                fontWeight: 600,
                opacity: on ? 1 : 0,
                transform: on ? "translateX(0)" : "translateX(-12px)",
              }}
            >
              <span style={{ color: n.accent ? COLORS.green : COLORS.textMuted, fontSize: 16 }}>
                {n.icon}
              </span>
              {n.label}
            </div>
          );
        })}
        <div
          style={{
            marginTop: "auto",
            height: 42,
            borderRadius: 12,
            background: COLORS.blurple,
            color: "#fff",
            fontFamily: INTER,
            fontWeight: 700,
            fontSize: 14.5,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
          }}
        >
          ＋ Add component
        </div>
      </div>
    </div>
  );
};
