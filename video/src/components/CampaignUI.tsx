import React from "react";
import { COLORS } from "../theme";
import { INTER } from "../fonts";
import { AddComponentBtn, TreeRow } from "./AppUI";
import { DMsg, DContainer, DHeading, DBody, DGallery, DBtn, DSelect } from "./DiscordUI";
import { Chip } from "./Bits";
import { Icon } from "./Icon";

export const CAMPAIGN_PROMPT = "Make the opening punchier and add a giveaway button.";

// Row order and the trailing Add-component button mirror the build scene's
// pane exactly — assistant/plugins/send continue that scene through hold cuts,
// so any drift here would pop on screen at the boundary.
export const CampaignTree: React.FC<{
  giveawayReveal?: number;
  selectedGiveaway?: boolean;
  attached?: boolean;
}> = ({ giveawayReveal = 1, selectedGiveaway = false, attached = false }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 7, flex: 1, minHeight: 0 }}>
    <TreeRow icon="▤" label="Container" depth={0} />
    <TreeRow icon="◧" label="Section" depth={1} />
    <TreeRow icon="¶" label="Text — Season 4 is live" depth={2} />
    <TreeRow icon="▦" label="Media Gallery" depth={1} />
    <TreeRow icon="⬚" label="Buttons Row" depth={1} />
    <TreeRow icon="▢" label="Button — Patch notes" depth={2} />
    <TreeRow icon="▢" label="Button — Claim reward" depth={2} />
    <TreeRow
      icon="▢"
      label="Button — Enter giveaway"
      depth={2}
      reveal={giveawayReveal}
      sel={selectedGiveaway}
      chip={attached ? "Giveaway" : undefined}
      chipColor="#f0b232"
    />
    <TreeRow icon="☰" label="String Select" depth={1} />
    <div style={{ marginTop: "auto" }}>
      <AddComponentBtn />
    </div>
  </div>
);

export const CampaignPreview: React.FC<{
  giveawayReveal?: number;
  giveawayGlow?: boolean;
  time?: string;
  scale?: number;
  punchy?: boolean;
}> = ({
  giveawayReveal = 1,
  giveawayGlow = false,
  time = "live preview",
  scale = 1,
  punchy = true,
}) => (
  <div
    style={{
      width: "100%",
      maxWidth: 720,
      transform: `scale(${scale})`,
      transformOrigin: "top center",
    }}
  >
    <DMsg author="Nebula Gaming" mascot time={time}>
      <DContainer accent={COLORS.green}>
        <DHeading icon="rocket">Season 4 is live</DHeading>
        <DBody>
          {punchy
            ? "New worlds. Bigger rewards. Season 4 starts now — claim your founder badge before the weekend."
            : "New maps, ranked rewards, and a fresh battle pass. Jump in and claim your founder badge before the weekend."}
        </DBody>
        <DGallery h={150} />
        <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
          <DBtn label="Patch notes" kind="primary" />
          <DBtn label="Claim reward" kind="success" emoji="🎁" />
          {giveawayReveal > 0.01 && (
            <div
              style={{
                opacity: giveawayReveal,
                transform: `translateX(${(1 - giveawayReveal) * 18}px) scale(${0.9 + giveawayReveal * 0.1})`,
              }}
            >
              <DBtn label="Enter giveaway" emoji="🎉" glow={giveawayGlow} />
            </div>
          )}
        </div>
        <DSelect placeholder="Choose your platform…" />
      </DContainer>
    </DMsg>
  </div>
);

export const AssistantDock: React.FC<{
  reveal: number;
  prompt: React.ReactNode;
  status: "prompt" | "thinking" | "done";
  replyReveal?: number;
}> = ({ reveal, prompt, status, replyReveal = 1 }) => (
  <div
    style={{
      position: "absolute",
      top: 44,
      bottom: 0,
      right: 0,
      width: 400,
      background: COLORS.bgElevated,
      borderLeft: `1px solid ${COLORS.borderStrong}`,
      boxShadow: "-24px 0 70px rgba(0,0,0,.48)",
      transform: `translateX(${(1 - reveal) * 420}px)`,
      display: "flex",
      flexDirection: "column",
      fontFamily: INTER,
      zIndex: 12,
    }}
  >
    <div
      style={{
        height: 54,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "0 16px",
        borderBottom: `1px solid ${COLORS.border}`,
        flexShrink: 0,
      }}
    >
      <div
        style={{
          width: 30,
          height: 30,
          borderRadius: 9,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, rgba(88,101,242,.28), rgba(235,69,158,.22))",
        }}
      >
        <Icon name="sparkle" size={18} color={COLORS.green} />
      </div>
      <span style={{ fontSize: 16, fontWeight: 800, color: COLORS.text }}>AI Assistant</span>
      <div style={{ flex: 1 }} />
      <span style={{ color: COLORS.textSubtle, fontSize: 17, fontWeight: 700 }}>✕</span>
    </div>

    <div
      style={{
        flex: 1,
        minHeight: 0,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 13,
      }}
    >
      <div
        style={{
          alignSelf: "flex-end",
          maxWidth: 318,
          background: "linear-gradient(135deg, #5865f2, #6f5de7)",
          color: "#fff",
          borderRadius: "14px 14px 4px 14px",
          padding: "11px 14px",
          fontSize: 14,
          lineHeight: 1.45,
          boxShadow: "0 10px 26px rgba(41,45,120,.3)",
        }}
      >
        {prompt}
      </div>

      {status === "thinking" && (
        <div
          style={{
            alignSelf: "flex-start",
            display: "flex",
            gap: 6,
            background: COLORS.bgSubtle,
            border: `1px solid ${COLORS.border}`,
            borderRadius: "14px 14px 14px 4px",
            padding: "13px 15px",
          }}
        >
          {[0.35, 0.65, 1].map((opacity, i) => (
            <div
              key={i}
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: COLORS.textMuted,
                opacity,
              }}
            />
          ))}
        </div>
      )}

      {status === "done" && (
        <div
          style={{
            alignSelf: "flex-start",
            maxWidth: 326,
            opacity: replyReveal,
            transform: `translateY(${(1 - replyReveal) * 12}px)`,
            background: COLORS.bgSubtle,
            border: `1px solid ${COLORS.border}`,
            borderRadius: "14px 14px 14px 4px",
            padding: "12px 14px",
            fontSize: 14,
            lineHeight: 1.48,
            color: COLORS.text,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
            <Icon name="wand" size={18} color={COLORS.green} />
            <span>Punched up the opening and added an Enter giveaway button.</span>
          </div>
          <Chip icon="check" color={COLORS.green}>
            Applied to your message
          </Chip>
        </div>
      )}
    </div>

    <div style={{ padding: 14, borderTop: `1px solid ${COLORS.border}`, display: "flex", gap: 9 }}>
      <div
        style={{
          flex: 1,
          background: COLORS.bgInput,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 10,
          padding: "10px 12px",
          fontSize: 13,
          color: COLORS.textSubtle,
        }}
      >
        Ask for another change…
      </div>
      <div
        style={{
          width: 38,
          height: 38,
          borderRadius: 10,
          background: COLORS.blurple,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name="send" size={16} color="#fff" />
      </div>
    </div>
  </div>
);
