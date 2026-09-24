import React from "react";
import { COLORS } from "../../theme";
import { INTER } from "../../fonts";
import { SEND, SERVER, type ChannelStatus } from "../../story/campaign";
import { NebulaIcon } from "./people";
import { PIcon } from "./ProductIcon";
import { useUi } from "./scale";
import { AppButton, ModalCard } from "./chrome";

/**
 * "Send message" — the Share dialog's Send tab (ShareDialog.tsx, SendPanel.tsx,
 * GuildWebhookPicker.tsx, sendCopy.ts), compressed into one card: the tab strip
 * (Send · Update · Restore · Share link · JSON · Code · About), the signed-in
 * lead, the Send now / Schedule choice, the channel-first list, and the footer
 * "Posting to <server>" + primary "Send to webhook". Nothing oversized: the
 * title is the largest type in the card.
 */

/** One channel in the channel-first list. */
export const SendChannelRow: React.FC<{
  name: string;
  status?: ChannelStatus;
  selected?: boolean;
  hover?: boolean;
  pressed?: boolean;
  /** 0..1 the status note fades in (after the pick). */
  statusReveal?: number;
  reveal?: number;
}> = ({ name, status = "create", selected = false, hover = false, pressed = false, statusReveal = 1, reveal = 1 }) => {
  const { u } = useUi();
  if (reveal <= 0.001) return null;
  const s = Math.max(0, Math.min(1, statusReveal));
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: u(10),
        padding: `${u(8)}px ${u(10)}px`,
        borderRadius: u(10),
        background: selected ? "rgba(88,101,242,0.18)" : hover ? COLORS.bgHover : COLORS.bg,
        border: `${u(1)}px solid ${selected ? COLORS.blurple : hover ? COLORS.borderStrong : COLORS.border}`,
        fontFamily: INTER,
        opacity: Math.min(1, reveal * 1.4),
        transform: pressed ? "scale(0.985)" : reveal < 1 ? `translateY(${(1 - reveal) * u(10)}px)` : undefined,
      }}
    >
      <span
        style={{
          width: u(32),
          height: u(32),
          borderRadius: 999,
          background: COLORS.bgHover,
          color: COLORS.textSubtle,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <PIcon name="hash" size={u(15)} />
      </span>
      <span style={{ flex: 1, minWidth: 0, fontSize: u(14), fontWeight: 600, color: COLORS.text, whiteSpace: "nowrap" }}>{name}</span>
      <span
        style={{
          display: "flex",
          alignItems: "center",
          gap: u(6),
          fontSize: u(12.5),
          fontWeight: status === "ready" ? 600 : 500,
          color: status === "ready" ? "#aeb6ff" : COLORS.textSubtle,
          opacity: s,
          whiteSpace: "nowrap",
        }}
      >
        {status === "ready" && <PIcon name="checkCircle" size={u(16)} color="#aeb6ff" />}
        {SEND.status[status]}
      </span>
    </div>
  );
};

export type SendPanelProps = {
  /** The picked channel (null = first-pick state, nothing selected). */
  selected?: string | null;
  /** Status per channel; defaults from the story (announcements ready, others create). */
  statuses?: Partial<Record<string, ChannelStatus>>;
  /** 0..1 per channel: its status note fades in. */
  statusReveal?: Partial<Record<string, number>>;
  hover?: string | null;
  pressed?: string | null;
  /** Primary "Send to webhook" states. */
  primaryHover?: boolean;
  primaryPressed?: boolean;
  primaryGlow?: number;
  primaryLabel?: string;
  timing?: "now" | "later";
  /** Tab strip (default: the product's seven, ShareDialog.tsx:98-104). */
  tabs?: string[];
  lead?: boolean;
  note?: boolean;
  /**
   * "popover": the desktop dialog card; "dialog": the phone dialog (a centred
   * card with the product's ≤ 640 px paddings); "sheet": a bottom sheet.
   */
  layout?: "popover" | "dialog" | "sheet";
  width?: number | string;
  reveal?: number;
};

export const SendPanel: React.FC<SendPanelProps> = ({
  selected = null,
  statuses = {},
  statusReveal = {},
  hover = null,
  pressed = null,
  primaryHover,
  primaryPressed,
  primaryGlow = 0,
  primaryLabel = SEND.primary,
  timing = "now",
  tabs = SEND.tabs,
  lead = true,
  note = true,
  layout = "popover",
  width = "100%",
  reveal = 1,
}) => {
  const { u } = useUi();
  const sheet = layout === "sheet";
  const phone = sheet || layout === "dialog";
  return (
    <ModalCard
      title={SEND.title}
      width={width}
      reveal={reveal}
      sheet={sheet}
      compact={layout === "dialog"}
      bodyGap={12}
      footer={
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: u(10),
            padding: sheet ? `${u(12)}px ${u(16)}px ${u(16)}px` : phone ? `${u(12)}px ${u(14)}px` : `${u(12)}px ${u(20)}px`,
            borderTop: `${u(1)}px solid ${COLORS.border}`,
            background: COLORS.bgElevated,
          }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: u(8), minWidth: 0 }}>
            <span style={{ fontSize: u(12), color: COLORS.textSubtle, whiteSpace: "nowrap" }}>{SEND.postingTo}</span>
            <NebulaIcon size={u(22)} shape="rounded" />
            <span style={{ fontSize: u(13), fontWeight: 600, whiteSpace: "nowrap" }}>{SERVER.name}</span>
          </span>
          <AppButton variant="primary" size="md" hover={primaryHover} pressed={primaryPressed} glow={primaryGlow}>
            {primaryLabel}
          </AppButton>
        </div>
      }
    >
      {/* The slim tab strip (.tabs: 4px padding, 12px/500 tabs). */}
      <div
        style={{
          display: "flex",
          gap: u(4),
          padding: u(4),
          alignSelf: "flex-start",
          borderRadius: u(10),
          background: COLORS.bg,
          border: `${u(1)}px solid ${COLORS.border}`,
          fontSize: u(12),
          fontWeight: 500,
          maxWidth: "100%",
        }}
      >
        {tabs.map((t, i) => (
          <span
            key={t}
            style={{
              padding: `${u(6)}px ${u(phone ? 8 : 12)}px`,
              borderRadius: u(6),
              whiteSpace: "nowrap",
              color: i === 0 ? COLORS.text : COLORS.textMuted,
              background: i === 0 ? COLORS.bgElevated : "transparent",
            }}
          >
            {t}
          </span>
        ))}
      </div>
      {lead && <p style={{ margin: 0, fontSize: u(13), lineHeight: 1.5, color: COLORS.textMuted }}>{SEND.lead}</p>}

      {/* Send now vs. Schedule (.modeToggle: two radio cards). */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: u(6) }}>
        {SEND.timing.map((m, i) => {
          const on = (i === 0) === (timing === "now");
          return (
            <div
              key={m.title}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: u(2),
                padding: `${u(9)}px ${u(12)}px`,
                borderRadius: u(10),
                background: on ? "rgba(88,101,242,0.18)" : COLORS.bg,
                border: `${u(1)}px solid ${on ? COLORS.blurple : COLORS.border}`,
              }}
            >
              <strong style={{ fontSize: u(13), fontWeight: 600 }}>{m.title}</strong>
              <span style={{ fontSize: u(12), color: COLORS.textMuted }}>{m.sub}</span>
            </div>
          );
        })}
      </div>

      {/* Channel-first destination (GuildWebhookPicker, first-pick state). */}
      <div style={{ display: "flex", flexDirection: "column", gap: u(8) }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: u(13), fontWeight: 600 }}>{SEND.pickerTitle}</span>
          <PIcon name="refresh" size={u(14)} color={COLORS.textSubtle} />
        </div>
        {note && <p style={{ margin: 0, fontSize: u(12), lineHeight: 1.5, color: COLORS.textMuted }}>{SEND.pickerNote}</p>}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: u(4),
            padding: u(8),
            borderRadius: u(10),
            background: COLORS.bgSubtle,
            border: `${u(1)}px solid ${COLORS.border}`,
          }}
        >
          {SEND.channels.map((c) => (
            <SendChannelRow
              key={c.name}
              name={c.name}
              status={statuses[c.name] ?? c.status}
              selected={selected === c.name}
              hover={hover === c.name}
              pressed={pressed === c.name}
              statusReveal={statusReveal[c.name] ?? 1}
            />
          ))}
        </div>
      </div>
    </ModalCard>
  );
};

