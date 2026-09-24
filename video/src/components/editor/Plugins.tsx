import React from "react";
import { COLORS } from "../../theme";
import { INTER } from "../../fonts";
import { withAlpha } from "../../lib/color";
import { PLUGINS, PLUGIN_COUNTS, pluginById } from "../../data";
import { GIVEAWAY_SETUP } from "../../story/campaign";
import { PIcon } from "./ProductIcon";
import { useUi } from "./scale";
import { AppButton, ModalCard } from "./chrome";

/**
 * Plugin attach, as the product does it (src/features/builder/components/
 * inspectors/PluginPanel.tsx + src/features/plugins/PluginLibraryModal.tsx):
 *   the selected button's inline editor shows the ACTION panel with
 *   "Browse plugins · 25" → the "Add an action" library → the attached chip
 *   "Giveaway · Founder badges · 3 winners · via Giveaway" [Reconfigure][Detach].
 * Counts and blurbs come from registry.json via data.ts.
 */

/* ── Plugin icon (PluginIcon.tsx BUILTIN_ICONS, path-for-path) ───────────── */

const BUILTIN: Record<string, { color: string; bg: string; paths: React.ReactNode }> = {
  "modal-form": {
    color: "#a78bfa",
    bg: "rgba(167, 139, 250, 0.14)",
    paths: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="2.5" />
        <path d="M3 8.5h18" />
        <path d="M7 13h10" />
        <path d="M7 17h6" />
      </>
    ),
  },
  "ping-pong": { color: "#34d399", bg: "rgba(52, 211, 153, 0.14)", paths: <path d="M2.5 12H6l2.5-7 6.5 14 2.5-7h4" /> },
  "self-role": {
    color: "#60a5fa",
    bg: "rgba(96, 165, 250, 0.14)",
    paths: (
      <>
        <circle cx="9" cy="7" r="4" />
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <path d="M15.5 11l2 2 4-4" />
      </>
    ),
  },
  tickets: {
    color: "#fbbf24",
    bg: "rgba(251, 191, 36, 0.14)",
    paths: (
      <>
        <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
        <path d="M13 5v2" />
        <path d="M13 11v2" />
        <path d="M13 17v2" />
      </>
    ),
  },
  giveaway: {
    color: "#f472b6",
    bg: "rgba(244, 114, 182, 0.14)",
    paths: (
      <>
        <rect x="3" y="8" width="18" height="4" rx="1" />
        <path d="M12 8v13" />
        <path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" />
        <path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5" />
      </>
    ),
  },
  "quick-replies": {
    color: "#2dd4bf",
    bg: "rgba(45, 212, 191, 0.14)",
    paths: (
      <>
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        <path d="m10 7-3 3 3 3" />
        <path d="M17 13v-1a2 2 0 0 0-2-2H7" />
      </>
    ),
  },
  poll: {
    color: "#818cf8",
    bg: "rgba(129, 140, 248, 0.14)",
    paths: (
      <>
        <path d="M6 20v-4" />
        <path d="M12 20V10" />
        <path d="M18 20V4" />
      </>
    ),
  },
};

/** A plugin's icon tile: the product's built-in SVG, else its default emoji. */
export const PluginGlyph: React.FC<{ id: string; size?: number }> = ({ id, size = 28 }) => {
  const b = BUILTIN[id];
  const { u } = useUi();
  const box: React.CSSProperties = {
    width: size,
    height: size,
    flexShrink: 0,
    borderRadius: u(6),
    border: `${u(1)}px solid ${COLORS.border}`,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
  };
  if (b) {
    return (
      <span style={{ ...box, color: b.color, background: b.bg }}>
        <svg
          width={size * 0.57}
          height={size * 0.57}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {b.paths}
        </svg>
      </span>
    );
  }
  const p = PLUGINS.find((x) => x.id === id);
  return (
    <span style={{ ...box, background: COLORS.bgSubtle, fontSize: size * 0.57, lineHeight: 1 }}>
      {p?.defaultEmoji ?? p?.name[0] ?? "?"}
    </span>
  );
};

/* ── ACTION panel (inline, under the selected button row) ────────────────── */

/** "ACTION — What happens when someone clicks this button." + Browse plugins · 25. */
export const InlineActionPanel: React.FC<{
  /** Pointer resting on the Browse card. */
  hover?: boolean;
  pressed?: boolean;
  /** The attached state replaces the Browse card with the plugin chip. */
  attached?: React.ReactNode;
}> = ({ hover = false, pressed = false, attached }) => {
  const { u } = useUi();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: u(10), fontFamily: INTER }}>
      <div style={{ display: "flex", flexDirection: "column", gap: u(2) }}>
        <span style={{ fontSize: u(12), fontWeight: 600, letterSpacing: "0.02em", color: COLORS.textMuted }}>ACTION</span>
        <span style={{ fontSize: u(12), color: COLORS.textMuted }}>What happens when someone clicks this button.</span>
      </div>
      {attached ?? (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: u(12),
              padding: `${u(12)}px ${u(14)}px`,
              borderRadius: u(10),
              background: hover
                ? "linear-gradient(180deg, rgba(88,101,242,0.24), rgba(88,101,242,0.12))"
                : "linear-gradient(180deg, rgba(88,101,242,0.16), rgba(88,101,242,0.07))",
              border: `${u(1)}px solid ${hover ? COLORS.blurple : "rgba(88,101,242,0.34)"}`,
              transform: pressed ? "scale(0.985)" : undefined,
            }}
          >
            <span
              style={{
                width: u(38),
                height: u(38),
                borderRadius: u(10),
                background: COLORS.blurple,
                boxShadow: "0 2px 10px rgba(88,101,242,0.45)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#fff",
                flexShrink: 0,
              }}
            >
              <PIcon name="puzzle" size={u(20)} />
            </span>
            <span style={{ display: "flex", flexDirection: "column", gap: u(2), flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: u(14), fontWeight: 600, color: COLORS.text }}>Browse plugins</span>
              <span style={{ fontSize: u(12), color: COLORS.textMuted }}>
                Let a ready-made action handle this — no bot code needed.
              </span>
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: u(6), flexShrink: 0 }}>
              <span
                style={{
                  fontSize: u(11),
                  fontWeight: 700,
                  padding: `${u(2)}px ${u(8)}px`,
                  borderRadius: 999,
                  background: COLORS.blurple,
                  color: "#fff",
                }}
              >
                {PLUGIN_COUNTS.buttonActions}
              </span>
              <PIcon name="chevronRight" size={u(18)} color="#aeb6ff" />
            </span>
          </div>
          <span style={{ display: "flex", alignItems: "center", gap: u(6), fontSize: u(12), color: COLORS.textSubtle }}>
            <PIcon name="chevronRight" size={u(14)} />
            <span style={{ fontWeight: 500 }}>Set the ID manually</span>
            <span>for your own bot</span>
          </span>
        </>
      )}
    </div>
  );
};

/**
 * The attached-plugin chip (PluginPanel.tsx AttachedChip): icon, the summary
 * label the config returned ("Giveaway"), its description ("Founder badges ·
 * 3 winners"), "via Giveaway", and Reconfigure / Detach.
 */
export const AttachedPluginChip: React.FC<{
  pluginId?: string;
  label?: string;
  detail?: string;
  via?: string;
  /** 0..1 landing spring (scale + fade). */
  reveal?: number;
  /** 0..1 attention glow. */
  glow?: number;
}> = ({
  pluginId = "giveaway",
  label = GIVEAWAY_SETUP.summaryLabel,
  detail = GIVEAWAY_SETUP.summary,
  via = GIVEAWAY_SETUP.via,
  reveal = 1,
  glow = 0,
}) => {
  const { u } = useUi();
  if (reveal <= 0.001) return null;
  const color = pluginById(pluginId).color;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: u(10),
        padding: u(10),
        borderRadius: u(6),
        background: COLORS.bgInput,
        border: `${u(1)}px solid ${glow > 0.01 ? withAlpha(color, 0.35 + 0.5 * glow) : COLORS.border}`,
        boxShadow: glow > 0.01 ? `0 0 ${u(22)}px ${withAlpha(color, 0.35 * glow)}` : undefined,
        opacity: Math.min(1, reveal * 1.5),
        transform: reveal < 1 ? `translateY(${(1 - reveal) * u(10)}px) scale(${0.94 + reveal * 0.06})` : undefined,
        fontFamily: INTER,
      }}
    >
      <PluginGlyph id={pluginId} size={u(28)} />
      <div style={{ display: "flex", flexDirection: "column", gap: u(1), minWidth: 0, flex: 1 }}>
        <span style={{ fontSize: u(13), fontWeight: 600, color: COLORS.text }}>{label}</span>
        {/* The app ellipsizes this line; the film lets it wrap so the prize and
            winner count stay fully readable at the narrow film pane. */}
        <span style={{ fontSize: u(12), color: COLORS.textMuted, lineHeight: 1.35 }}>
          {detail.replace(/(\d) (winners?)/, `$1${String.fromCharCode(0xa0)}$2`)}
        </span>
        <span style={{ fontSize: u(11), color: withAlpha(COLORS.textMuted, 0.8) }}>{via}</span>
      </div>
      <div style={{ display: "flex", gap: u(6), flexShrink: 0 }}>
        <AppButton variant="secondary" size="sm">
          Reconfigure
        </AppButton>
        <AppButton variant="ghost" size="sm">
          Detach
        </AppButton>
      </div>
    </div>
  );
};

/* ── "Add an action" library ─────────────────────────────────────────────── */

/** The four interactive plugins the film features (registry order is the rest). */
export const FEATURED_PLUGINS = ["giveaway", "tickets", "self-role", "modal-form"] as const;
/** Named on the row under the cards (the other button-capable interactive ones). */
export const MORE_PLUGINS = ["poll", "quick-replies", "directory", "ping-pong"] as const;

export type ActionCardState = {
  /** Pointer over the card: hover fill + the accent strip grows in. */
  hover?: number;
  /** A travelling light sweep, 0..1 across (the VO names the card). */
  glint?: number;
  /** Picked (after the click). */
  selected?: boolean;
};

const CategoryHead: React.FC<{
  kind: "interactive" | "link";
  count: number;
  sub: string;
  collapsed?: boolean;
  lit?: number;
}> = ({ kind, count, sub, collapsed, lit = 0 }) => {
  const { u } = useUi();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: u(10) }}>
      <span
        style={{
          width: u(30),
          height: u(30),
          borderRadius: u(9),
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: kind === "interactive" ? "#fff" : "#0b1220",
          background: kind === "interactive" ? COLORS.blurple : "linear-gradient(135deg, #5eead4, #38bdf8)",
          boxShadow: lit > 0.01 ? `0 0 ${u(18)}px ${withAlpha("#38bdf8", 0.6 * lit)}` : undefined,
        }}
      >
        <PIcon name={kind === "interactive" ? "puzzle" : "globe"} size={u(16)} />
      </span>
      <span style={{ display: "flex", flexDirection: "column", gap: u(1), flex: 1, minWidth: 0 }}>
        <span style={{ display: "flex", alignItems: "baseline", gap: u(8) }}>
          <span style={{ fontSize: u(12), fontWeight: 700, letterSpacing: "0.03em", color: COLORS.text }}>
            {kind === "interactive" ? "INTERACTIVE" : "LINK TO A SERVICE"}
          </span>
          <span style={{ fontSize: u(11), fontWeight: 600, color: COLORS.textSubtle }}>{count}</span>
        </span>
        <span style={{ fontSize: u(12), color: COLORS.textMuted }}>{sub}</span>
      </span>
      {collapsed !== undefined && (
        <PIcon name={collapsed ? "chevronRight" : "chevronDown"} size={u(18)} color={COLORS.textSubtle} />
      )}
    </div>
  );
};

const ActionCard: React.FC<{ id: string; state?: ActionCardState; clampLines?: number; nameSize?: number }> = ({
  id,
  state = {},
  clampLines = 3,
  nameSize = 13,
}) => {
  const { u } = useUi();
  const p = pluginById(id);
  const hover = Math.max(0, Math.min(1, state.hover ?? 0));
  const glint = state.glint;
  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        gap: u(10),
        padding: `${u(12)}px ${u(12)}px ${u(12)}px ${u(12)}px`,
        borderRadius: u(6),
        background: state.selected ? withAlpha(COLORS.blurple, 0.16) : hover > 0 ? COLORS.bgHover : COLORS.bgInput,
        border: `${u(1)}px solid ${state.selected ? COLORS.blurple : hover > 0 ? COLORS.borderStrong : COLORS.border}`,
        overflow: "hidden",
        fontFamily: INTER,
        boxSizing: "border-box",
        height: "100%",
      }}
    >
      {/* The hover strip that grows from the left edge (.header::before). */}
      <span
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: u(3),
          background: COLORS.blurple,
          transform: `scaleY(${state.selected ? 1 : hover})`,
        }}
      />
      {glint !== undefined && glint > 0 && glint < 1 && (
        <span
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: `${-40 + glint * 140}%`,
            width: "40%",
            background: "linear-gradient(100deg, transparent, rgba(255,255,255,0.10) 45%, rgba(255,255,255,0.18) 50%, rgba(255,255,255,0.10) 55%, transparent)",
            pointerEvents: "none",
          }}
        />
      )}
      <PluginGlyph id={id} size={u(28)} />
      <span style={{ display: "flex", flexDirection: "column", gap: u(2), minWidth: 0, flex: 1 }}>
        <span style={{ display: "flex", alignItems: "center", gap: u(8) }}>
          <span style={{ fontSize: u(nameSize), fontWeight: 600, color: COLORS.text }}>{p.name}</span>
          {state.selected && (
            <span style={{ marginLeft: "auto", color: COLORS.blurple, display: "flex" }}>
              <PIcon name="checkCircle" size={u(18)} color="#aeb6ff" />
            </span>
          )}
        </span>
        <span
          style={{
            fontSize: u(12),
            lineHeight: 1.45,
            color: COLORS.textMuted,
            display: "-webkit-box",
            WebkitLineClamp: clampLines,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {p.desc}
        </span>
      </span>
    </div>
  );
};

/**
 * "Add an action" — the combined button library, compressed for the film:
 * the search field ("Search 25 actions…"), the INTERACTIVE section with four
 * featured cards (registry blurbs) + a line naming the rest, and the LINK TO A
 * SERVICE section collapsed to its header. `layout="sheet"` stacks the cards
 * for the portrait stage.
 */
export const AddActionModal: React.FC<{
  cards?: Partial<Record<(typeof FEATURED_PLUGINS)[number], ActionCardState>>;
  /** 0..1 lights the "and more" line + the collapsed link section. */
  moreLit?: number;
  searchText?: string;
  layout?: "dialog" | "sheet";
  width?: number | string;
  reveal?: number;
}> = ({ cards = {}, moreLit = 0, searchText, layout = "dialog", width = "100%", reveal = 1 }) => {
  const { u } = useUi();
  const sheet = layout === "sheet";
  const others = MORE_PLUGINS.map((id) => pluginById(id).name);
  return (
    <ModalCard title="Add an action" width={width} reveal={reveal} sheet={sheet}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: u(8),
          height: u(38),
          padding: `0 ${u(12)}px`,
          borderRadius: u(6),
          background: COLORS.bgInput,
          border: `${u(1)}px solid ${COLORS.blurple}`,
          boxShadow: `0 0 0 ${u(2)}px ${withAlpha(COLORS.blurple, 0.35)}`,
          fontSize: u(14),
          color: searchText ? COLORS.text : COLORS.textSubtle,
        }}
      >
        <PIcon name="search" size={u(16)} color={COLORS.textSubtle} />
        {searchText ?? `Search ${PLUGIN_COUNTS.buttonActions} actions…`}
      </div>

      <CategoryHead kind="interactive" count={PLUGIN_COUNTS.interactiveForButton} sub="Handled by DWEEB — no bot code needed." />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: sheet ? "1fr" : "1fr 1fr",
          gap: u(8),
        }}
      >
        {FEATURED_PLUGINS.map((id) => (
          <ActionCard key={id} id={id} state={cards[id]} clampLines={sheet ? 1 : 3} nameSize={sheet ? 14.5 : 13} />
        ))}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: u(8),
          padding: `${u(9)}px ${u(12)}px`,
          borderRadius: u(6),
          border: `${u(1)}px dashed ${moreLit > 0.01 ? withAlpha(COLORS.blurple, 0.5 + 0.5 * moreLit) : COLORS.border}`,
          background: moreLit > 0.01 ? withAlpha(COLORS.blurple, 0.1 * moreLit) : "transparent",
          fontSize: u(13),
          color: moreLit > 0.5 ? COLORS.text : COLORS.textMuted,
        }}
      >
        <span style={{ display: "flex" }}>
          {MORE_PLUGINS.map((id, i) => (
            <span key={id} style={{ marginLeft: i === 0 ? 0 : -u(6), display: "flex", boxShadow: `0 0 0 ${u(2)}px ${COLORS.bgElevated}`, borderRadius: u(6) }}>
              <PluginGlyph id={id} size={u(22)} />
            </span>
          ))}
        </span>
        <span>
          {others.join(" · ")}
        </span>
      </div>
      <div
        style={{
          padding: `${u(10)}px ${u(12)}px`,
          borderRadius: u(6),
          border: `${u(1)}px solid ${COLORS.border}`,
          background: moreLit > 0.01 ? withAlpha("#38bdf8", 0.07 * moreLit) : COLORS.bgSubtle,
        }}
      >
        <CategoryHead
          kind="link"
          count={PLUGIN_COUNTS.linkServices}
          sub="Opens an external page — works on any webhook, never expires."
          collapsed
          lit={moreLit}
        />
      </div>
    </ModalCard>
  );
};
