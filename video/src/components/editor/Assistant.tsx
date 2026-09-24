import React from "react";
import { COLORS } from "../../theme";
import { INTER } from "../../fonts";
import { AI } from "../../story/campaign";
import { PIcon } from "./ProductIcon";
import { UiScale, useUi } from "./scale";

/**
 * The AI Assistant (src/features/ai/AiChatPanel.tsx + .module.css) with the
 * film's beat states: the prompt is TYPED in the composer, then sent as your
 * bubble; the reply bubble shows the product's typing dots while it thinks,
 * then the reply with the "✦ Updated the message · Undo" receipt.
 *
 * Landscape: a docked column that slides in from the right edge; its shadow
 * scales with `reveal`, so a parked dock casts nothing. Portrait: the same
 * content as a bottom sheet. Pass `zoom` to size the dock on its own (the spec
 * wants ≥17px dock text in the landscape world: zoom ≈ 1.32 on 13px bubbles).
 */

/** The product's dotPulse (1.2s cycle, 0.2s stagger): opacity .3→1, lift 3px at 30%. */
export const ThinkingDots: React.FC<{ frame: number; fps?: number; size?: number; color?: string }> = ({
  frame,
  fps = 30,
  size = 6,
  color = COLORS.textMuted,
}) => {
  const { u } = useUi();
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: u(5), height: "1.2em" }}>
      {[0, 0.2, 0.4].map((delay, i) => {
        const cycle = (((frame / fps - delay) % 1.2) + 1.2) % 1.2 / 1.2; // 0..1
        const peak = cycle < 0.3 ? cycle / 0.3 : cycle < 0.6 ? 1 - (cycle - 0.3) / 0.3 : 0;
        const e = Math.sin((peak * Math.PI) / 2);
        return (
          <span
            key={i}
            style={{
              width: u(size),
              height: u(size),
              borderRadius: "50%",
              background: color,
              opacity: 0.3 + 0.7 * e,
              transform: `translateY(${-u(3) * e}px)`,
            }}
          />
        );
      })}
    </span>
  );
};

/** "✦ Updated the message · Undo" — the applied-edit receipt with its Undo. */
export const AppliedChip: React.FC<{ reveal?: number }> = ({ reveal = 1 }) => {
  const { u } = useUi();
  if (reveal <= 0.001) return null;
  const r = Math.min(1, reveal);
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: u(6),
        marginTop: u(8),
        padding: `${u(4)}px ${u(6)}px ${u(4)}px ${u(9)}px`,
        borderRadius: 999,
        // The film sets the receipt at the bubble size (13px, not the app's
        // 11px) so the dock's "applied" beat clears the ≥17px landscape rule.
        fontSize: u(13),
        fontWeight: 600,
        color: "#2dc06b",
        background: "rgba(35,165,89,0.14)",
        opacity: r,
        transform: r < 1 ? `scale(${0.85 + 0.15 * r})` : undefined,
        transformOrigin: "left center",
        whiteSpace: "nowrap",
      }}
    >
      <PIcon name="sparkle" size={u(14)} color="#2dc06b" />
      <span>{AI.applied}</span>
      <span
        style={{
          marginLeft: u(2),
          padding: `${u(2)}px ${u(6)}px`,
          borderRadius: 999,
          fontWeight: 700,
          textDecoration: "underline",
          textUnderlineOffset: u(2),
        }}
      >
        {AI.undo}
      </span>
    </div>
  );
};

/** AiChatPanel.tsx:29-34 — the empty state's suggestion chips. */
const SUGGESTIONS = [
  "Build a welcome message in a blurple container with a title and a Join button.",
  "Add a row of link buttons to the docs and GitHub.",
  "Make an announcement with a heading, a short blurb, and an image gallery.",
  "Turn this into a clean product card with a thumbnail and a buy button.",
];

/**
 * The panel before the first message (AiChatPanel.tsx EmptyState): "Build with
 * AI", the provider line ("DWEEB AI (built-in)", core/ai/providerMeta.ts:55)
 * and the suggestion chips — what a viewer sees while the prompt is typed.
 */
const EmptyState: React.FC<{ suggestions: number }> = ({ suggestions }) => {
  const { u } = useUi();
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", padding: `${u(18)}px ${u(8)}px` }}>
      <div
        style={{
          width: u(56),
          height: u(56),
          borderRadius: u(16),
          background: "rgba(88,101,242,0.18)",
          color: COLORS.blurple,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          marginBottom: u(14),
        }}
      >
        <PIcon name="sparkle" size={u(28)} />
      </div>
      <div style={{ fontSize: u(16), fontWeight: 600, marginBottom: u(6) }}>Build with AI</div>
      <div style={{ fontSize: u(12), lineHeight: 1.5, color: COLORS.textMuted, maxWidth: "36ch", marginBottom: u(16) }}>
        Tell me what you want and I'll build it directly in the editor — using{" "}
        <strong style={{ color: COLORS.text, fontWeight: 700 }}>DWEEB AI (built-in)</strong>. Try one of these:
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: u(8), width: "100%" }}>
        {SUGGESTIONS.slice(0, suggestions).map((s) => (
          <div
            key={s}
            style={{
              textAlign: "left",
              fontSize: u(12.5),
              lineHeight: 1.4,
              color: COLORS.text,
              background: COLORS.bg,
              border: `${u(1)}px solid ${COLORS.border}`,
              borderRadius: u(10),
              padding: `${u(10)}px ${u(12)}px`,
            }}
          >
            {s}
          </div>
        ))}
      </div>
    </div>
  );
};

export type AssistantPanelProps = {
  /** How many suggestion chips the empty state lists (0 hides them). */
  suggestions?: number;
  /** 0..1 slide-in (dock: from the right; sheet: from the bottom). */
  reveal?: number;
  /** Text typed in the composer so far ("" shows the placeholder). */
  composer?: string;
  /** Draw the caret at the end of the composer text. */
  caret?: boolean;
  caretOn?: boolean;
  /** Your sent bubble (null until sent). */
  sent?: React.ReactNode;
  /** 0..1 pop of the sent bubble. */
  sentReveal?: number;
  /** The assistant bubble shows typing dots. */
  thinking?: boolean;
  /** Scene frame for the dots' phase. */
  frame?: number;
  /** Reply text (may be partial for a stream). */
  reply?: string | null;
  replyReveal?: number;
  /** 0..1 "Updated the message · Undo" receipt. */
  applied?: number;
  /** The usage line; null hides it. */
  usage?: string | null;
  sendPressed?: boolean;
  layout?: "dock" | "sheet";
  width?: number | string;
  height?: number | string;
  zoom?: number;
};

const Body: React.FC<AssistantPanelProps> = ({
  reveal = 1,
  composer = "",
  caret = false,
  caretOn = true,
  sent = null,
  sentReveal = 1,
  thinking = false,
  frame = 0,
  reply = null,
  replyReveal = 1,
  applied = 0,
  usage = AI.usage(0),
  sendPressed = false,
  layout = "dock",
  width = "100%",
  height = "100%",
  suggestions = 2,
}) => {
  const { u } = useUi();
  const sheet = layout === "sheet";
  const empty = !sent && !thinking && !reply;
  const r = Math.max(0, Math.min(1, reveal));
  if (r <= 0.001) return null;
  return (
    <div
      style={{
        width,
        height,
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        background: COLORS.bgElevated,
        borderLeft: sheet ? undefined : `${u(1)}px solid ${COLORS.border}`,
        border: sheet ? `${u(1)}px solid ${COLORS.border}` : undefined,
        borderBottom: sheet ? "none" : undefined,
        borderRadius: sheet ? `${u(18)}px ${u(18)}px 0 0` : 0,
        // The shadow scales with the reveal — nothing is cast while parked.
        boxShadow: sheet
          ? `0 -${u(18)}px ${u(50)}px rgba(0,0,0,${(0.5 * r).toFixed(3)})`
          : `-${u(24) * r}px 0 ${u(70) * r}px rgba(0,0,0,${(0.48 * r).toFixed(3)})`,
        transform: r < 1 ? (sheet ? `translateY(${(1 - r) * 100}%)` : `translateX(${(1 - r) * 100}%)`) : undefined,
        fontFamily: INTER,
        color: COLORS.text,
        overflow: "hidden",
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
          gap: u(8),
          padding: `${u(12)}px ${u(14)}px`,
          borderBottom: `${u(1)}px solid ${COLORS.border}`,
          flexShrink: 0,
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: u(8), fontSize: u(14), fontWeight: 600 }}>
          <PIcon name="sparkle" size={u(18)} color={COLORS.blurple} />
          {AI.title}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: u(2), color: COLORS.textMuted }}>
          {sent && (
            <span style={{ width: u(30), height: u(30), display: "flex", alignItems: "center", justifyContent: "center" }}>
              <PIcon name="trash" size={u(16)} />
            </span>
          )}
          <span style={{ width: u(30), height: u(30), display: "flex", alignItems: "center", justifyContent: "center" }}>
            <PIcon name="settings" size={u(16)} />
          </span>
          <span style={{ width: u(30), height: u(30), display: "flex", alignItems: "center", justifyContent: "center" }}>
            <PIcon name="close" size={u(16)} />
          </span>
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, padding: u(14), display: "flex", flexDirection: "column", gap: u(10), overflow: "hidden" }}>
        {empty && <EmptyState suggestions={suggestions} />}
        {sent && sentReveal > 0.001 && (
          <div
            style={{
              alignSelf: "flex-end",
              maxWidth: "85%",
              padding: `${u(9)}px ${u(12)}px`,
              borderRadius: u(14),
              borderBottomRightRadius: u(4),
              background: COLORS.blurple,
              color: "#fff",
              fontSize: u(13),
              lineHeight: 1.5,
              opacity: Math.min(1, sentReveal * 1.5),
              transform: sentReveal < 1 ? `translateY(${(1 - sentReveal) * u(12)}px) scale(${0.94 + 0.06 * sentReveal})` : undefined,
              transformOrigin: "right bottom",
            }}
          >
            {sent}
          </div>
        )}
        {(thinking || reply) && replyReveal > 0.001 && (
          <div
            style={{
              alignSelf: "flex-start",
              maxWidth: "85%",
              padding: `${u(9)}px ${u(12)}px`,
              borderRadius: u(14),
              borderBottomLeftRadius: u(4),
              background: COLORS.bg,
              border: `${u(1)}px solid ${COLORS.border}`,
              fontSize: u(13),
              lineHeight: 1.5,
              opacity: Math.min(1, replyReveal * 1.5),
              transform: replyReveal < 1 ? `translateY(${(1 - replyReveal) * u(10)}px)` : undefined,
            }}
          >
            {reply ? <span>{reply}</span> : <ThinkingDots frame={frame} />}
            {reply && <div>{<AppliedChip reveal={applied} />}</div>}
          </div>
        )}
      </div>

      {usage && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: `${u(6)}px ${u(14)}px`,
            borderTop: `${u(1)}px solid ${COLORS.border}`,
            fontSize: u(12),
            color: COLORS.textMuted,
            flexShrink: 0,
          }}
        >
          {usage}
        </div>
      )}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: u(8),
          padding: usage ? `${u(8)}px ${u(14)}px ${u(12)}px` : `${u(12)}px ${u(14)}px`,
          borderTop: usage ? undefined : `${u(1)}px solid ${COLORS.border}`,
          flexShrink: 0,
        }}
      >
        <div
          style={{
            flex: 1,
            minHeight: u(38),
            boxSizing: "border-box",
            padding: `${u(9)}px ${u(12)}px`,
            borderRadius: u(10),
            background: COLORS.bgInput,
            border: `${u(1)}px solid ${caret ? COLORS.blurple : COLORS.border}`,
            fontSize: u(13),
            lineHeight: 1.4,
            color: composer ? COLORS.text : COLORS.textSubtle,
            whiteSpace: "pre-wrap",
          }}
        >
          {composer || (caret ? "" : AI.placeholder)}
          {caret && (
            <span
              style={{
                display: "inline-block",
                width: u(2),
                height: "1.1em",
                verticalAlign: "-0.18em",
                marginLeft: u(1),
                background: caretOn ? COLORS.text : "transparent",
                borderRadius: 1,
              }}
            />
          )}
        </div>
        {thinking ? (
          <div
            style={{
              height: u(38),
              padding: `0 ${u(14)}px`,
              boxSizing: "border-box",
              borderRadius: u(10),
              background: COLORS.bgActive,
              border: `${u(1)}px solid ${COLORS.borderStrong}`,
              fontSize: u(13),
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              flexShrink: 0,
            }}
          >
            Stop
          </div>
        ) : (
          <div
            style={{
              width: u(38),
              height: u(38),
              borderRadius: u(10),
              background: sendPressed ? COLORS.blurpleHover : COLORS.blurple,
              opacity: composer.trim() ? 1 : 0.45,
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              transform: sendPressed ? "scale(0.94)" : undefined,
            }}
          >
            <PIcon name="send" size={u(16)} />
          </div>
        )}
      </div>
    </div>
  );
};

export const AssistantPanel: React.FC<AssistantPanelProps> = (props) =>
  props.zoom ? (
    <UiScale k={props.zoom}>
      <Body {...props} />
    </UiScale>
  ) : (
    <Body {...props} />
  );
