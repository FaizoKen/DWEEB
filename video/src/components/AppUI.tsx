import React from "react";
import { COLORS } from "../theme";
import { INTER } from "../fonts";
import { Icon } from "./Icon";

/**
 * The DWEEB editor's browser window (AppWindow): the chrome and the two-pane
 * shell that editor/Layouts' EditorWindow fills. Scenes compose EditorWindow /
 * PortraitEditor and the editor/* parts, never this directly.
 */

/* ── Window & layout ─────────────────────────────────────────────────────── */

/**
 * Browser chrome + the app's two-pane shell (builder left, preview right).
 * `overlay` renders last inside the window (which clips it), for docked panels
 * like the AI assistant, the plugin picker, or the Send popover.
 *
 * `assembly` (0..1 per part, default settled) lets the reveal scene build the
 * editor AROUND the preview: the chrome drops in, the builder pane slides in,
 * and the window's own border/shadow fades up with them, while the preview
 * pane — carrying the matched card from the hook — is present from frame one.
 */
export type WindowAssembly = { chrome?: number; left?: number };

export const AppWindow: React.FC<{
  width: number;
  height: number;
  url?: string;
  left: React.ReactNode;
  right: React.ReactNode;
  leftWidth?: number;
  overlay?: React.ReactNode;
  assembly?: WindowAssembly;
  /** Builder-pane padding (v5: 16). v6 panes draw a full-bleed bar: pass 0. */
  leftPadding?: number;
  /** Gap between builder-pane children (v5: 12). */
  leftGap?: number;
  /** Preview-pane padding (v5: 26). */
  rightPadding?: number;
  /** Preview message alignment (v5: centred). */
  rightAlign?: "center" | "start";
}> = ({
  width,
  height,
  url = "dweeb.faizo.net",
  left,
  right,
  leftWidth = 560,
  overlay,
  assembly,
  leftPadding = 16,
  leftGap = 12,
  rightPadding = 26,
  rightAlign = "center",
}) => {
  const chromeP = Math.max(0, Math.min(1, assembly?.chrome ?? 1));
  const leftP = Math.max(0, Math.min(1, assembly?.left ?? 1));
  const shellP = Math.max(chromeP, leftP);

  return (
    <div
      style={{
        width,
        height,
        // While assembling, the shell itself is still transparent so the
        // preview pane (carrying the matched card) floats alone on the stage.
        background: shellP < 1 ? `rgba(23,25,31,${shellP.toFixed(3)})` : COLORS.bgElevated,
        borderRadius: 18,
        overflow: "hidden",
        border: `1px solid rgba(59,65,80,${shellP.toFixed(3)})`,
        boxShadow: `0 40px 120px rgba(0,0,0,${(0.6 * shellP).toFixed(3)})`,
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
          opacity: chromeP,
          transform: chromeP < 1 ? `translateY(${(1 - chromeP) * -46}px)` : undefined,
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
            boxSizing: "border-box",
            background: COLORS.bg,
            borderRight: `1px solid ${COLORS.border}`,
            display: "flex",
            flexDirection: "column",
            padding: leftPadding,
            gap: leftGap,
            position: "relative",
            overflow: "hidden",
            opacity: leftP,
            transform: leftP < 1 ? `translateX(${(1 - leftP) * -72}px)` : undefined,
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
            justifyContent: rightAlign === "center" ? "center" : "flex-start",
            padding: rightPadding,
            overflow: "hidden",
          }}
        >
          {right}
        </div>
      </div>
      {overlay}
    </div>
  );
};
