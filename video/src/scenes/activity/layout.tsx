import React from "react";
import { COLORS } from "../../theme";
import { INTER } from "../../fonts";
import { withAlpha } from "../../lib/color";
import {
  DiscordScale,
  PIcon,
  PORTRAIT_STAGE,
  PORTRAIT_UI,
  UiScale,
  UserAvatar,
  treeLayout,
  useDiscord,
  useUi,
} from "../../components/editor";
import { DBtn, DContainer, DMsg, DRow, DSelected, DTextDisplay } from "../../components/DiscordUI";
import {
  AUTHOR,
  CAST,
  LAUNCH_NIGHT,
  PREVIEW_TIME,
  launchRows,
  launchText,
  type CastMember,
  type LaunchState,
  type TreeAdderModel,
} from "../../story/campaign";
import { ACT_RECT_L } from "./voice";

/**
 * The Discord Activity, laid out the way src/activity/ActivityApp lays it out.
 *
 * Desktop (wider than 900 px): two equal columns (ActivityApp.module.css .panes, 1fr
 * 1fr). The Activity bar tops the EDITOR column only — "so the header tops the
 * editor only and the preview pane stays uncluttered" — above the component
 * tree (whose MetaHeader carries the stat pills); the preview column runs the
 * full height with the presence dock floated 16 px into its bottom-right
 * corner (.presenceFab). The shared ActivityShell spans the bar across both
 * panes, so these scenes compose the product layout here from the same parts.
 *
 * Portrait: the same stylisation of a phone as the editor act's PortraitEditor
 * (bar strip, the live preview, a builder sheet with the tree) so the vertical
 * cut reads as one app, with the dock pinned bottom-right at the mobile dock's
 * fixed 165 px width (PresenceDock.module.css @media ≤ 900 px).
 *
 * Every size is authored at the product's CSS metrics × the zoom, and the
 * geometry helpers below derive cursor aims from the SAME numbers the
 * renderer uses.
 */

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/* ── The message model extras (story/campaign.ts has the rest) ──────────── */

/** The dashed adders under the Action row and the Container (ComponentTree.tsx:1674/1698). */
export function launchAdders(ls: LaunchState): TreeAdderModel[] {
  const last = ls.buttons[ls.buttons.length - 1].id;
  return [
    ...(ls.buttons.length < 5 ? [{ id: "addButton" as const, label: "Add button", depth: 2, after: last }] : []),
    { id: "addToContainer" as const, label: "Add to container", depth: 1, after: last },
  ];
}

/**
 * The MetaHeader pills for a Launch night state, by the product's counting
 * rules (traversal.ts countComponents / countCharacters, the same rules as
 * campaignStats): every component counts; characters are the username, the
 * text content and the button labels.
 */
export function launchStats(ls: LaunchState): { components: number; chars: number } {
  return {
    components: 1 /* container */ + 1 /* text */ + 1 /* action row */ + ls.buttons.length,
    chars: AUTHOR.length + launchText(ls).length + ls.buttons.reduce((n, b) => n + b.label.length, 0),
  };
}

/* ── Presence dock ───────────────────────────────────────────────────────── */

/**
 * The bottom-right presence dock, drawn at PresenceDock.tsx / .module.css's
 * metrics: the "+" affordance (lit accent while the dock is hovered — the whole
 * bar is the invite button), then everyone in the room as 24 px avatars in
 * 2 px separator rings, you first with the green live ring.
 *
 * Local because a teammate must ARRIVE smoothly: the shared PresenceDock gives
 * a joining avatar its full layout width on its first frame, so the dock (and
 * its "+") jumps sideways by a whole avatar the moment Kai appears. Here the
 * slot grows with the join, so the dock widens under the pop instead.
 */
export const JoinDock: React.FC<{
  /** 0..1 Kai's arrival (0 = just you). */
  kai: number;
  hover?: boolean;
  pressed?: boolean;
  /** 0..1 attention ring on the whole dock (Kai's arrival). */
  glow?: number;
  /** Fixed width in CSS px: the mobile dock is pinned to 165 px; omit to hug (desktop). */
  width?: number;
}> = ({ kai, hover = false, pressed = false, glow = 0, width }) => {
  const { u } = useUi();
  const j = clamp01(kai);
  const lit = hover || pressed;
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: u(8),
        width: width !== undefined ? u(width) : undefined,
        boxSizing: "border-box",
        padding: `${u(5)}px ${u(8)}px`,
        borderRadius: u(14),
        background: COLORS.bgElevated,
        border: `${u(1)}px solid ${hover ? COLORS.borderStrong : COLORS.border}`,
        boxShadow: [
          `0 ${u(4)}px ${u(16)}px rgba(0,0,0,0.45)`,
          glow > 0.01
            ? `0 0 0 ${u(2)}px ${withAlpha(COLORS.blurple, 0.75 * glow)}, 0 0 ${u(24)}px ${withAlpha(COLORS.blurple, 0.45 * glow)}`
            : "",
        ]
          .filter(Boolean)
          .join(", "),
        transform: pressed ? "scale(0.96)" : undefined,
        fontFamily: INTER,
      }}
    >
      <span
        style={{
          width: u(28),
          height: u(28),
          flexShrink: 0,
          boxSizing: "border-box",
          borderRadius: "50%",
          border: `${u(1)}px solid ${lit ? COLORS.blurple : COLORS.border}`,
          background: lit ? COLORS.blurple : COLORS.bg,
          color: lit ? "#fff" : COLORS.textMuted,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <PIcon name="plus" size={u(16)} />
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", marginLeft: "auto" }}>
        <DockSlot person={CAST.aria} self />
        {j > 0.001 && <DockSlot person={CAST.kai} join={j} />}
      </span>
    </div>
  );
};

/** One avatar slot: 24 px avatar in a 2 px ring of the dock's own colour; others overlap by 8 px. */
const DockSlot: React.FC<{ person: CastMember; self?: boolean; join?: number }> = ({ person, self = false, join = 1 }) => {
  const { u } = useUi();
  const size = u(28);
  const avatar = (
    <span
      style={{
        display: "inline-flex",
        borderRadius: "50%",
        border: `${u(2)}px solid ${COLORS.bgElevated}`,
        boxShadow: self ? `0 0 0 ${u(2)}px #2dc06b` : undefined,
      }}
    >
      <UserAvatar person={person} size={u(24)} />
    </span>
  );
  if (self) return <span style={{ position: "relative", zIndex: 1, display: "inline-flex" }}>{avatar}</span>;
  // The slot's layout share grows 0 → 20 px (28 wide, −8 overlap) with the join;
  // the avatar itself pops in (scale + fade) centred in that growing slot.
  return (
    <span style={{ position: "relative", flexShrink: 0, width: size * join, height: size, marginLeft: -u(8) * join }}>
      <span
        style={{
          position: "absolute",
          left: (size * join - size) / 2,
          top: 0,
          display: "inline-flex",
          opacity: join < 1 ? Math.min(1, join * 1.6) : undefined,
          transform: join < 1 ? `scale(${0.4 + 0.6 * join})` : undefined,
        }}
      >
        {avatar}
      </span>
    </span>
  );
};

/** The mobile dock's fixed width (PresenceDock.module.css @media ≤ 900 px). */
export const MOBILE_DOCK_W = 165;

/* ── The Launch night preview ───────────────────────────────────────────── */

const Popped: React.FC<{ p: number; children: React.ReactNode }> = ({ p, children }) => {
  if (p <= 0.001) return null;
  if (p >= 1) return <>{children}</>;
  return (
    <div style={{ opacity: Math.min(1, p * 1.6), transform: `scale(${0.6 + 0.4 * p})`, transformOrigin: "left center" }}>
      {children}
    </div>
  );
};

/**
 * The next message, as DWEEB's preview renders it: the webhook identity
 * (Nebula Gaming + server icon, APP badge, the preview's frozen clock), the
 * orange Container, the Text Display ("# 🎮 Launch night" + body) and the
 * button row. No collaborator marks: the real preview shows none.
 */
export const LaunchPreview: React.FC<{
  launch: LaunchState;
  /** 0..1 entrance of the suggest button (Aria's add). */
  suggestPop?: number;
  /** 0..1 glow on the suggest button. */
  suggestGlow?: number;
  /** 0..1 the preview's selection ring on it (a selected tree row mirrors here). */
  suggestSelected?: number;
}> = ({ launch, suggestPop = 1, suggestGlow = 0, suggestSelected = 0 }) => (
  <DMsg author={AUTHOR} avatar="nebula" time={PREVIEW_TIME}>
    <DContainer accent={LAUNCH_NIGHT.accent}>
      <DTextDisplay content={launchText(launch)} />
      <DRow>
        {launch.buttons.map((b) => {
          const btn = (
            <DBtn
              label={b.label}
              kind={b.kind}
              emoji={b.emoji}
              glow={b.id === LAUNCH_NIGHT.suggest.id ? suggestGlow : 0}
            />
          );
          if (b.id !== LAUNCH_NIGHT.suggest.id) return <React.Fragment key={b.id}>{btn}</React.Fragment>;
          return (
            <Popped key={b.id} p={suggestPop}>
              <DSelected on={suggestSelected}>{btn}</DSelected>
            </Popped>
          );
        })}
      </DRow>
    </DContainer>
  </DMsg>
);

/* ── Landscape: the Activity in the call ────────────────────────────────── */

/**
 * The desktop Activity in world px: it runs in the voice call's focused tile
 * (voice.tsx ACT_RECT_L, 1322 × 700 inside the Discord window's call stage),
 * laid out at 1000 CSS px wide — two 500 px columns, above the product's
 * 900 px breakpoint — so its zoom is 1.322 and it is a 1000 × 530 CSS-px
 * Activity. Pushed in on (voice camera, S08Activity), the whole Activity
 * fills the frame at s ≈ 1.42: its 13 px tree labels land at ~24 canvas px.
 */
export const ACT_L = { ...ACT_RECT_L, k: ACT_RECT_L.w / 1000, dk: ACT_RECT_L.w / 1000 } as const;

const WIN_BORDER = 1;
const COL_W = (ACT_L.w - 2 * WIN_BORDER) / 2;
/** Tree scroll padding (ComponentTree .scroll 10px) and the pills-only MetaHeader box (49 + 12 margin). */
const PANE_PAD = 10;
const META_BOX = 49;
const META_GAP = 12;
const BAR_H = 44;

/** World-px landmarks of the landscape Activity window (inside its 1px border). */
export const GEO_L = (() => {
  const { k } = ACT_L;
  const inner = { x: ACT_L.x + WIN_BORDER, y: ACT_L.y + WIN_BORDER, w: ACT_L.w - 2 * WIN_BORDER, h: ACT_L.h - 2 * WIN_BORDER };
  const editor = { x: inner.x, y: inner.y, w: COL_W - 1 /* its right border */, h: inner.h };
  const preview = { x: inner.x + COL_W, y: inner.y, w: COL_W, h: inner.h };
  return {
    inner,
    editor,
    preview,
    tree: {
      x: editor.x + PANE_PAD * k,
      y: editor.y + (BAR_H + PANE_PAD + META_BOX + META_GAP) * k,
      w: editor.w - 2 * PANE_PAD * k,
    },
  };
})();

export const ActivityWindowL: React.FC<{
  bar: React.ReactNode;
  meta: React.ReactNode;
  tree: React.ReactNode;
  preview: React.ReactNode;
  /** Bottom-right stack: tooltip over the dock. */
  dock: React.ReactNode;
}> = (props) => (
  <UiScale k={ACT_L.k}>
    <DiscordScale k={ACT_L.dk}>
      <WindowL {...props} />
    </DiscordScale>
  </UiScale>
);

const WindowL: React.FC<React.ComponentProps<typeof ActivityWindowL>> = ({ bar, meta, tree, preview, dock }) => {
  const { u } = useUi();
  const { d } = useDiscord();
  return (
    <div
      style={{
        position: "absolute",
        left: ACT_L.x,
        top: ACT_L.y,
        width: ACT_L.w,
        height: ACT_L.h,
        boxSizing: "border-box",
        display: "grid",
        gridTemplateColumns: `${COL_W}px ${COL_W}px`,
        // Embedded in the call's focused tile: Discord's 8 px tile radius and
        // a hairline against the black stage, no floating shadow.
        borderRadius: 8,
        overflow: "hidden",
        background: COLORS.bg,
        border: `${WIN_BORDER}px solid ${withAlpha("#ffffff", 0.08)}`,
        fontFamily: INTER,
      }}
    >
      <div style={{ position: "relative", minWidth: 0, overflow: "hidden", background: COLORS.bg, borderRight: `1px solid ${COLORS.border}` }}>
        {bar}
        <div style={{ position: "absolute", left: 0, right: 0, top: u(BAR_H), bottom: 0, overflow: "hidden" }}>
          <div style={{ padding: u(PANE_PAD) }}>
            <div style={{ height: u(META_BOX), marginBottom: u(META_GAP), overflow: "hidden" }}>{meta}</div>
            {tree}
          </div>
        </div>
      </div>
      <div style={{ position: "relative", minWidth: 0, overflow: "hidden", background: COLORS.dBgPrimary }}>
        {/* Preview.module.css: .scroll padding 24/16, .message padding 4/16. */}
        <div style={{ padding: `${d(24)}px ${d(16)}px` }}>
          <div style={{ padding: `${d(4)}px ${d(16)}px` }}>{preview}</div>
        </div>
        <div
          style={{
            position: "absolute",
            right: u(16),
            bottom: u(16),
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: u(8),
          }}
        >
          {dock}
        </div>
      </div>
    </div>
  );
};

/* ── Portrait: the Activity on the portrait stage ───────────────────────── */

/** Surface zooms and the builder sheet's top (surface units), as in the editor act. */
export const ACT_V = { k: 1.07, dk: 1.0, sheetTop: 270 } as const;

const V_W = PORTRAIT_STAGE.w - 2 * PORTRAIT_UI.side; // 520
const V_H = PORTRAIT_UI.bottom - PORTRAIT_UI.top; // 740
const V_LEFT = PORTRAIT_STAGE.x + PORTRAIT_UI.side;
const V_TOP = PORTRAIT_STAGE.y + PORTRAIT_UI.top;

/** World landmarks of the portrait Activity (content box, inside the 1 px border). */
export const GEO_V = (() => {
  const { k, sheetTop } = ACT_V;
  const ox = V_LEFT + 1;
  const oy = V_TOP + 1;
  // Sheet: 1 px border, 8k padding, 5k grabber + 10k gap, pills (24k + 10 below).
  const treeTop = sheetTop + 1 + 8 * k + 5 * k + 10 * k + 24 * k + 10;
  return {
    origin: { x: ox, y: oy },
    tree: { x: ox + 10 * k, y: oy + treeTop, w: V_W - 20 * k },
  };
})();

export const ActivityPortrait: React.FC<{
  bar: React.ReactNode;
  preview: React.ReactNode;
  pills: React.ReactNode;
  tree: React.ReactNode;
  dock: React.ReactNode;
}> = (props) => (
  <UiScale k={ACT_V.k}>
    <DiscordScale k={ACT_V.dk}>
      <SurfaceV {...props} />
    </DiscordScale>
  </UiScale>
);

const SurfaceV: React.FC<React.ComponentProps<typeof ActivityPortrait>> = ({ bar, preview, pills, tree, dock }) => {
  const { u } = useUi();
  const { sheetTop } = ACT_V;
  return (
    <div
      style={{
        position: "absolute",
        left: V_LEFT,
        top: V_TOP,
        width: V_W,
        height: V_H,
        borderRadius: 18,
        overflow: "hidden",
        background: COLORS.bg,
        border: "1px solid rgb(59,65,80)",
        boxShadow: "0 30px 90px rgba(0,0,0,0.55)",
        fontFamily: INTER,
      }}
    >
      {bar}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: u(BAR_H),
          height: sheetTop - u(BAR_H) + 18,
          background: COLORS.dBgPrimary,
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "14px 12px" }}>{preview}</div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: sheetTop,
          height: V_H - sheetTop,
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          padding: `${u(8)}px ${u(10)}px 0`,
          background: COLORS.bgElevated,
          borderTop: `1px solid ${COLORS.borderStrong}`,
          borderRadius: "18px 18px 0 0",
          boxShadow: "0 -18px 50px rgba(0,0,0,0.45)",
        }}
      >
        <div style={{ alignSelf: "center", width: u(40), height: u(5), borderRadius: 3, background: COLORS.borderStrong, marginBottom: u(10), flexShrink: 0 }} />
        <div style={{ padding: "0 4px 10px", flexShrink: 0 }}>{pills}</div>
        <div style={{ position: "relative", flex: 1, minHeight: 0, overflow: "hidden" }}>{tree}</div>
      </div>
      <div
        style={{
          position: "absolute",
          right: u(16),
          bottom: u(16),
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: u(8),
        }}
      >
        {dock}
      </div>
    </div>
  );
};

/* ── Geometry for aims ──────────────────────────────────────────────────── */

export type Box = { x: number; y: number; w: number; h: number; cx: number; cy: number };

const box = (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h, cx: x + w / 2, cy: y + h / 2 });

/** A tree row / adder box in world px, from the same treeLayout() the TreeView renders. */
export function launchTreeBox(vertical: boolean, ls: LaunchState, id: string, reveal?: Record<string, number>): Box {
  const k = vertical ? ACT_V.k : ACT_L.k;
  const o = vertical ? GEO_V.tree : GEO_L.tree;
  const b = treeLayout(launchRows(ls), launchAdders(ls), { k, reveal }).box(id);
  if (!b) throw new Error(`launchTreeBox: no "${id}" in the ${vertical ? "portrait" : "landscape"} tree`);
  return box(o.x + b.x, o.y + b.y, o.w - b.x, b.h);
}

/** The "+" circle at the left of a dashed adder pill (TreeAdder: 5 padding, 16 icon). */
export function adderIcon(b: Box, vertical: boolean): { x: number; y: number } {
  const k = vertical ? ACT_V.k : ACT_L.k;
  return { x: b.x + (1 + 5 + 8) * k, y: b.cy };
}
