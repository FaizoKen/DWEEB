import React from "react";
import { COLORS } from "../theme";
import { INTER } from "../fonts";
import { Icon } from "./Icon";

/** A browser-style window chrome wrapping app content, with a URL bar. */
export const AppFrame: React.FC<{
  children: React.ReactNode;
  width: number;
  height: number;
  url?: string;
}> = ({ children, width, height, url = "dweeb.faizo.net" }) => {
  return (
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
      }}
    >
      <div
        style={{
          height: 46,
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
            height: 28,
            background: COLORS.bgInput,
            borderRadius: 8,
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "0 12px",
            fontFamily: INTER,
            fontSize: 14,
            color: COLORS.textMuted,
          }}
        >
          <Icon name="lock" size={15} color={COLORS.green} />
          {url}
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>{children}</div>
    </div>
  );
};
