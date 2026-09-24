import React from "react";
import { COLORS } from "../../theme";
import { INTER } from "../../fonts";
import { withAlpha } from "../../lib/color";
import { templateById, TEMPLATE_COUNT, type TemplateMeta } from "../../data";
import {
  AUTHOR,
  BUTTONS,
  CAMPAIGN_ACCENT,
  DIRECTORY,
  PREVIEW_TIME,
  STOCK_ART,
  campaignState,
  pickToast,
  textContent,
} from "../../story/campaign";
import { DBtn, DContainer, DGallery, DMsg, DRow, DSelect, DTextDisplay, DT } from "../DiscordUI";
import { NebulaIcon } from "./people";
import { PIcon } from "./ProductIcon";
import { DiscordScale, useUi } from "./scale";
import { AppToast } from "./chrome";

/**
 * The Message directory (src/features/templates/TemplateGallery.tsx +
 * galleryCards.tsx): the overlay the editor's bookmark icon opens. Header with
 * the connected server's icon + "Message directory", the signed-in subtitle,
 * the explore links, "Search 36 templates…" and the Template chip; a grid of
 * cards with LIVE previews ("Use this template →" on hover); "36 results" and
 * "Start from scratch" in the footer.
 */

/* ── Card previews: small live renders of each template ─────────────────── */

const DefaultAvatarMsg: React.FC<{ author: string; children: React.ReactNode }> = ({ author, children }) => (
  <DMsg author={author} time={PREVIEW_TIME} avatar={{ name: author, color: "#5865f2" }}>
    {children}
  </DMsg>
);

/** A painted banner stand-in for a template's own header image. */
const Banner: React.FC<{ from: string; to: string; h?: number }> = ({ from, to, h = 70 }) => (
  <div
    style={{
      height: h,
      borderRadius: 8,
      background: `linear-gradient(135deg, ${from}, ${to})`,
      position: "relative",
      overflow: "hidden",
    }}
  >
    <div style={{ position: "absolute", inset: 0, background: "radial-gradient(120% 90% at 18% 10%, rgba(255,255,255,.22), transparent 55%)" }} />
  </div>
);

const PREVIEWS: Record<string, () => React.ReactNode> = {
  // The campaign's stock state — what the pick loads into the editor, stock
  // key art included (the Season 4 hero only arrives in the build).
  announcement: () => {
    const s = campaignState("stock");
    return (
      <DMsg author={AUTHOR} time={PREVIEW_TIME} avatar="nebula">
        <DContainer accent={CAMPAIGN_ACCENT}>
          <DTextDisplay content={textContent(s)} />
          <DGallery swap={{ ...STOCK_ART, t: 1 }} />
          <DRow>
            <DBtn label={BUTTONS.patch.label} kind="link" />
          </DRow>
        </DContainer>
      </DMsg>
    );
  },
  welcome: () => (
    <DefaultAvatarMsg author="Welcome">
      <DContainer accent="#5865f2">
        <DTextDisplay content={"# 👋 Welcome to the server!\nWe're really glad you found us. Here's everything you need to settle in."} />
        <Banner from="#2a2f8f" to="#5865f2" />
        <DRow>
          <DBtn label="📖 Community guide" kind="link" />
          <DBtn label="💬 Jump into chat" kind="link" />
        </DRow>
      </DContainer>
    </DefaultAvatarMsg>
  ),
  "patch-notes": () => (
    <DefaultAvatarMsg author="Changelog">
      <DContainer accent="#9b59b6">
        <DTextDisplay content={"# 🛠️ Patch Notes — v2.4\n-# Released June 16, 2026"} />
        <DTextDisplay content={"### ✨ New\n- Added dark-mode dashboards\n- You can now pin up to 10 favourites"} />
        <DTextDisplay content={"### 🔧 Improved\n- 30% faster load times\n- Cleaner mobile layout"} />
      </DContainer>
    </DefaultAvatarMsg>
  ),
  showcase: () => (
    <DefaultAvatarMsg author="DWEEB">
      <DContainer accent="#5865f2">
        <DTextDisplay
          content={
            "# 🧩 The Components V2 starter kit\nA hands-on tour of every block DWEEB gives you — and it's all live. **Click any component in the editor to edit it**, watch the preview update instantly, then hit **Send** or **Share** when it looks right."
          }
        />
        <Banner from="#1d2140" to="#3b3f8f" h={64} />
      </DContainer>
    </DefaultAvatarMsg>
  ),
  spotlight: () => (
    <DefaultAvatarMsg author="Spotlight">
      <DTextDisplay content={"# 🌟 Member Spotlight"} />
      <div style={{ height: 8 }} />
      <DGallery art={["ridge", "sun", "hero"]} />
      <div style={{ height: 8 }} />
      <DTextDisplay content={"This week we're celebrating **@artist** for their incredible series above."} />
    </DefaultAvatarMsg>
  ),
  event: () => (
    <DefaultAvatarMsg author="Events">
      <DContainer accent="#e67e22">
        <DTextDisplay content={"# 🎟️ Community Game Night\n### Friday, June 20 · 8:00 PM ET\nJump into voice for a relaxed evening of party games."} />
        <DRow>
          <DBtn label="RSVP — I'm in!" kind="success" emoji="🎟️" />
        </DRow>
      </DContainer>
    </DefaultAvatarMsg>
  ),
  "giveaway-button": () => (
    <DefaultAvatarMsg author="Giveaways">
      <DContainer accent="#fee75c">
        <DTextDisplay content={"# 🎉 GIVEAWAY 🎉\n### 🎁 {prize}\nTap **Enter** below — the count ticks up live and a fair winner is drawn on its own."} />
        <DRow>
          <DBtn label="Enter Giveaway" kind="success" emoji="🎉" />
        </DRow>
      </DContainer>
    </DefaultAvatarMsg>
  ),
  poll: () => (
    <DefaultAvatarMsg author="Polls">
      <DContainer accent="#3498db">
        <DTextDisplay content={"# 📊 Community Poll\n**{question}**"} />
        <DTextDisplay content={"> 🗳️ **{votes}** ballots cast · status: **{status}**"} />
        <DSelect placeholder="Cast your vote…" />
      </DContainer>
    </DefaultAvatarMsg>
  ),
};

/* ── Card ───────────────────────────────────────────────────────────────── */

export type TemplateCardState = {
  /** Pointer over the card: lift, border, the "Use this template →" overlay. */
  hover?: number;
  /** Pressed "Use this template" (after the click). */
  pressed?: boolean;
  /** Highlight ring (picked). */
  selected?: boolean;
};

/** One directory card (galleryCards.tsx TemplateCard + .card styles). */
export const TemplateCard: React.FC<{ template: TemplateMeta; state?: TemplateCardState; previewH?: number }> = ({
  template: t,
  state = {},
  previewH = 196,
}) => {
  const { k, u } = useUi();
  const hover = Math.max(0, Math.min(1, state.hover ?? 0));
  const preview = PREVIEWS[t.id];
  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        background: COLORS.bgSubtle,
        border: `${u(1)}px solid ${state.selected ? COLORS.blurple : hover > 0 ? COLORS.borderStrong : COLORS.border}`,
        borderRadius: u(14),
        overflow: "hidden",
        fontFamily: INTER,
        transform: hover > 0 ? `translateY(${-u(4) * hover}px)` : undefined,
        boxShadow: [
          hover > 0 ? `0 ${u(10)}px ${u(30)}px rgba(0,0,0,${(0.45 * hover).toFixed(3)})` : "",
          state.selected ? `0 0 0 ${u(2)}px ${withAlpha(COLORS.blurple, 0.6)}` : "",
        ]
          .filter(Boolean)
          .join(", ") || undefined,
      }}
    >
      <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: u(3), background: t.accent, zIndex: 2 }} />
      <div style={{ position: "relative", height: u(previewH), overflow: "hidden", background: DT.canvas, borderBottom: `${u(1)}px solid ${COLORS.border}` }}>
        <div style={{ position: "absolute", left: u(12), right: u(12), top: u(14) }}>
          <DiscordScale k={0.56 * k}>{preview ? preview() : null}</DiscordScale>
        </div>
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: u(56),
            background: `linear-gradient(to top, ${COLORS.bgSubtle}, transparent)`,
            zIndex: 1,
          }}
        />
        {t.interactive && (
          <span
            style={{
              position: "absolute",
              top: u(10),
              right: u(10),
              zIndex: 3,
              padding: `${u(3)}px ${u(8)}px`,
              borderRadius: 999,
              fontSize: u(11),
              fontWeight: 600,
              color: "#f7cb6b",
              background: "rgba(20,16,8,0.82)",
              border: `${u(1)}px solid rgba(240,178,50,0.4)`,
            }}
          >
            Interactive
          </span>
        )}
        {hover > 0.01 && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 2,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: `rgba(10,11,15,${(0.45 * hover).toFixed(3)})`,
            }}
          >
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: u(6),
                padding: `${u(9)}px ${u(16)}px`,
                borderRadius: 999,
                background: state.pressed ? COLORS.blurpleHover : COLORS.blurple,
                color: "#fff",
                fontSize: u(13),
                fontWeight: 600,
                boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
                opacity: hover,
                transform: `translateY(${(1 - hover) * u(6)}px) scale(${state.pressed ? 0.95 : 1})`,
              }}
            >
              {DIRECTORY.useTemplate}
              <PIcon name="arrowRight" size={u(14)} strokeWidth={2.2} />
            </span>
          </div>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: u(7), padding: `${u(13)}px ${u(14)}px ${u(14)}px`, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: u(9), minWidth: 0 }}>
          <span style={{ fontSize: u(18), lineHeight: 1 }}>{t.emoji}</span>
          <span style={{ fontSize: u(15), fontWeight: 650, color: COLORS.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {t.name}
          </span>
        </div>
        <p
          style={{
            margin: 0,
            fontSize: u(13),
            lineHeight: 1.45,
            color: COLORS.textMuted,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            minHeight: `${2 * 1.45}em`,
          }}
        >
          {t.description}
        </p>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: u(6), marginTop: "auto", paddingTop: u(4) }}>
          <span
            style={{
              padding: `${u(2)}px ${u(8)}px`,
              borderRadius: 999,
              fontSize: u(11),
              fontWeight: 600,
              letterSpacing: "0.02em",
              color: COLORS.textSubtle,
              background: COLORS.bgInput,
              border: `${u(1)}px solid ${COLORS.border}`,
            }}
          >
            {t.category}
          </span>
          {t.pairsWith && (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: u(4),
                padding: `${u(2)}px ${u(8)}px`,
                borderRadius: 999,
                fontSize: u(11),
                fontWeight: 600,
                color: "#aeb6ff",
                background: "rgba(88,101,242,0.18)",
              }}
            >
              <PIcon name="puzzle" size={u(12)} />
              {t.pairsWith}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

/* ── The overlay ────────────────────────────────────────────────────────── */

export type MessageDirectoryProps = {
  /** Template ids in grid order. */
  cards?: string[];
  /** Per-card states by id. */
  states?: Partial<Record<string, TemplateCardState>>;
  columns?: number;
  /** Search box text (default: the placeholder "Search 36 templates…"). */
  searchText?: string;
  signedIn?: boolean;
  layout?: "overlay" | "sheet";
  width?: number | string;
  height?: number | string;
  /** 0..1 rise-in (the product's galleryRise). */
  reveal?: number;
  /** Vertical scroll of the card grid (px at the current zoom). */
  scrollY?: number;
  previewH?: number;
};

export const DEFAULT_DIRECTORY_CARDS = [
  "showcase",
  "welcome",
  "announcement",
  "spotlight",
  "event",
  "giveaway-button",
  "patch-notes",
  "poll",
];

export const MessageDirectory: React.FC<MessageDirectoryProps> = ({
  cards = DEFAULT_DIRECTORY_CARDS,
  states = {},
  columns = 4,
  searchText,
  signedIn = true,
  layout = "overlay",
  width = "100%",
  height = "100%",
  reveal = 1,
  scrollY = 0,
  previewH,
}) => {
  const { u } = useUi();
  if (reveal <= 0.001) return null;
  const r = Math.min(1, reveal);
  const sheet = layout === "sheet";
  return (
    <div
      style={{
        width,
        height,
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        background: COLORS.bgElevated,
        border: `${u(1)}px solid ${COLORS.border}`,
        borderRadius: sheet ? `${u(18)}px ${u(18)}px 0 0` : u(14),
        boxShadow: `0 ${u(16)}px ${u(48)}px rgba(0,0,0,${(0.6 * r).toFixed(3)})`,
        overflow: "hidden",
        fontFamily: INTER,
        color: COLORS.text,
        opacity: sheet ? 1 : Math.min(1, r * 1.5),
        transform: r < 1 ? (sheet ? `translateY(${(1 - r) * 100}%)` : `translateY(${(1 - r) * u(18)}px) scale(${0.98 + 0.02 * r})`) : undefined,
      }}
    >
      {sheet && (
        <div style={{ display: "flex", justifyContent: "center", paddingTop: u(8) }}>
          <div style={{ width: u(40), height: u(5), borderRadius: 3, background: COLORS.borderStrong }} />
        </div>
      )}
      <div
        style={{
          flexShrink: 0,
          padding: sheet ? `${u(10)}px ${u(16)}px ${u(12)}px` : `${u(16)}px ${u(24)}px ${u(14)}px`,
          borderBottom: `${u(1)}px solid ${COLORS.border}`,
          background: `radial-gradient(120% 140% at 0% 0%, rgba(88,101,242,0.12), transparent 60%), ${COLORS.bgElevated}`,
          display: "flex",
          flexDirection: "column",
          gap: u(10),
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: u(16) }}>
          <div style={{ display: "flex", flexDirection: "column", gap: u(4), minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: u(9), fontSize: u(20), fontWeight: 700, letterSpacing: "-0.01em" }}>
              {signedIn ? (
                <NebulaIcon size={u(28)} shape="rounded" />
              ) : (
                <span
                  style={{
                    width: u(28),
                    height: u(28),
                    borderRadius: u(8),
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#fff",
                    background: "linear-gradient(135deg, #5865f2 0%, #8a5cf6 60%, #c026d3 100%)",
                  }}
                >
                  <PIcon name="sparkle" size={u(17)} />
                </span>
              )}
              {DIRECTORY.title}
            </div>
            <p style={{ margin: 0, fontSize: u(13), color: COLORS.textMuted, maxWidth: "60ch", lineHeight: 1.45 }}>
              {signedIn ? DIRECTORY.subtitle : DIRECTORY.subtitleSignedOut}
            </p>
          </div>
          <span
            style={{
              width: u(36),
              height: u(36),
              borderRadius: u(8),
              border: `${u(1)}px solid ${COLORS.border}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: COLORS.textMuted,
              flexShrink: 0,
            }}
          >
            <PIcon name="close" size={u(18)} />
          </span>
        </div>
        {!sheet && (
          <div style={{ display: "flex", gap: u(18), fontSize: u(13), color: "#aeb6ff" }}>
            {["Message builder", "Templates", "Features", "Guides", "About & methodology"].map((l) => (
              <span key={l}>{l}</span>
            ))}
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: u(10) }}>
          <div
            style={{
              flex: sheet ? 1 : "0 1 420px",
              display: "flex",
              alignItems: "center",
              gap: u(8),
              height: u(40),
              boxSizing: "border-box",
              padding: `0 ${u(14)}px`,
              borderRadius: 999,
              background: COLORS.bgInput,
              border: `${u(1)}px solid ${COLORS.border}`,
              fontSize: u(14),
              color: searchText ? COLORS.text : COLORS.textSubtle,
            }}
          >
            <PIcon name="search" size={u(16)} color={COLORS.textSubtle} />
            {searchText ?? `Search ${TEMPLATE_COUNT} templates…`}
          </div>
          <span
            style={{
              height: u(32),
              padding: `0 ${u(14)}px`,
              display: "flex",
              alignItems: "center",
              borderRadius: 999,
              background: COLORS.blurple,
              color: "#fff",
              fontSize: u(13),
              fontWeight: 500,
              flexShrink: 0,
            }}
          >
            Template
          </span>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: "hidden", position: "relative" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            gap: u(sheet ? 12 : 18),
            padding: sheet ? u(14) : `${u(22)}px ${u(24)}px`,
            transform: scrollY ? `translateY(${-scrollY}px)` : undefined,
          }}
        >
          {cards.map((id) => (
            <TemplateCard key={id} template={templateById(id)} state={states[id]} previewH={previewH ?? (sheet ? 150 : 196)} />
          ))}
        </div>
      </div>

      <div
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: sheet ? `${u(10)}px ${u(16)}px ${u(14)}px` : `${u(12)}px ${u(24)}px`,
          borderTop: `${u(1)}px solid ${COLORS.border}`,
          fontSize: u(13),
        }}
      >
        <span style={{ color: COLORS.textMuted }}>{TEMPLATE_COUNT} results</span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: u(8),
            height: u(36),
            padding: `0 ${u(14)}px`,
            borderRadius: u(8),
            border: `${u(1)}px solid ${COLORS.border}`,
            fontWeight: 600,
          }}
        >
          <PIcon name="plus" size={u(16)} />
          {DIRECTORY.startFromScratch}
        </span>
      </div>
    </div>
  );
};

/** The pick toast: "Loaded the “Announcement” template — make it yours, then Send." */
export const TemplatePickToast: React.FC<{ name?: string; reveal?: number; maxWidth?: number }> = ({
  name = "Announcement",
  reveal = 1,
  maxWidth = 360,
}) => <AppToast message={pickToast(name)} tone="success" reveal={reveal} maxWidth={maxWidth} />;
