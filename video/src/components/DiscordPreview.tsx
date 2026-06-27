import React from "react";
import { COLORS } from "../theme";
import { INTER } from "../fonts";
import { Icon, IconName } from "./Icon";

const Btn: React.FC<{ label: string; kind?: "primary" | "secondary" | "success"; icon?: IconName }> = ({
  label,
  kind = "secondary",
  icon,
}) => {
  const bg =
    kind === "primary"
      ? COLORS.dButtonPrimary
      : kind === "success"
        ? COLORS.dButtonSuccess
        : COLORS.dButtonSecondary;
  return (
    <div
      style={{
        background: bg,
        color: "#fff",
        fontFamily: INTER,
        fontWeight: 600,
        fontSize: 15,
        padding: "9px 16px",
        borderRadius: 8,
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        whiteSpace: "nowrap",
      }}
    >
      {icon && <Icon name={icon} size={18} color="#fff" />}
      {label}
    </div>
  );
};

const Media: React.FC<{ from: string; to: string; tall?: boolean; label?: string }> = ({
  from,
  to,
  tall,
  label,
}) => (
  <div
    style={{
      position: "relative",
      flex: 1,
      height: tall ? 168 : 120,
      borderRadius: 8,
      background: `linear-gradient(135deg, ${from}, ${to})`,
      overflow: "hidden",
    }}
  >
    <div
      style={{
        position: "absolute",
        inset: 0,
        background:
          "radial-gradient(120% 80% at 20% 10%, rgba(255,255,255,0.25), transparent 50%)",
      }}
    />
    {label && (
      <div
        style={{
          position: "absolute",
          top: 8,
          left: 8,
          fontFamily: INTER,
          fontSize: 11,
          fontWeight: 700,
          color: "rgba(255,255,255,0.85)",
          background: "rgba(0,0,0,0.4)",
          padding: "2px 7px",
          borderRadius: 5,
        }}
      >
        {label}
      </div>
    )}
  </div>
);

/**
 * A faithful Discord "Components V2" message: webhook author + APP tag, an
 * accent-barred container with a heading, body copy, a media gallery and a row
 * of buttons. Slots (children) can be revealed progressively by the scene.
 */
export const DiscordPreview: React.FC<{
  show?: number; // 0..n how many blocks are revealed
  width?: number;
  botName?: string;
  botColor?: string;
}> = ({ show = 99, width = 720, botName = "DWEEB", botColor = COLORS.blurple }) => {
  return (
    <div
      style={{
        width,
        background: COLORS.dBgPrimary,
        borderRadius: 16,
        padding: "20px 22px 24px",
        fontFamily: INTER,
        boxShadow: "0 30px 80px rgba(0,0,0,0.5)",
        border: `1px solid ${COLORS.dBgTertiary}`,
      }}
    >
      {/* author row */}
      <div style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 12 }}>
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: "50%",
            background: botColor,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="bot" size={26} color="#fff" />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: "#fff", fontWeight: 700, fontSize: 17 }}>{botName}</span>
          <span
            style={{
              background: botColor,
              color: "#fff",
              fontSize: 11,
              fontWeight: 700,
              padding: "1px 5px",
              borderRadius: 4,
            }}
          >
            APP
          </span>
          <span style={{ color: COLORS.dTextMuted, fontSize: 13 }}>Today at 9:41 AM</span>
        </div>
      </div>

      {/* container with accent bar */}
      <div
        style={{
          display: "flex",
          gap: 14,
          background: COLORS.dBgSecondary,
          borderRadius: 10,
          padding: 16,
        }}
      >
        <div style={{ width: 4, borderRadius: 4, background: COLORS.green, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: "#fff", fontWeight: 800, fontSize: 22, marginBottom: 6, display: "flex", alignItems: "center", gap: 8 }}>
            <Icon name="rocket" size={24} color={COLORS.green} />
            Season 4 is live
          </div>
          {show >= 1 && (
            <div style={{ color: COLORS.dText, fontSize: 16, lineHeight: 1.45, marginBottom: 14 }}>
              New maps, ranked rewards, and a fresh battle pass. Jump in and claim your
              founder badge before the weekend.
            </div>
          )}
          {show >= 2 && (
            <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
              <Media from="#5865F2" to="#23a559" tall label="ALT" />
              <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
                <Media from="#f0b232" to="#f04747" />
                <Media from="#00a8fc" to="#5865F2" />
              </div>
            </div>
          )}
          {show >= 3 && (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <Btn label="Claim reward" kind="success" icon="gift" />
              <Btn label="Patch notes" kind="primary" icon="notes" />
              <Btn label="Invite friends" icon="link" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
