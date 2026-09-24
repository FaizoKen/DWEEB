import React from "react";
import { Audio, Easing, Sequence, spring, staticFile } from "remotion";
import { settle } from "../../components/Bits";
import { CampaignPreview, CampaignTree, type CampaignPreviewProps } from "../../components/CampaignUI";
import {
  AssistantPanel,
  DiscordScale,
  EditorWindow,
  PORTRAIT_STAGE,
  PORTRAIT_UI,
  PortraitEditor,
  PreviewFabs,
  editorWindowGeometry,
  portraitEditorGeometry,
  treeLayout,
  type AssistantPanelProps,
  type EditorActionBarProps,
  type TreeEditorSlot,
} from "../../components/editor";
import { campaignAdders, campaignRows, campaignStats, type CampaignState } from "../../story/campaign";
import { FPS } from "../../timeline";
import { EDITOR_L, EDITOR_V } from "../contracts";

/**
 * The editor act's second half — assistant → plugins → send — drawn by ONE
 * frame component per aspect (LandscapeAct / PortraitAct). The three scenes
 * only feed it state, so the two hold cuts between them are identical by
 * construction: same state in, same pixels out. With no dock, sheet,
 * selection or flourish, a frame is exactly cut B of contracts.ts (the build
 * scene's last frame), which the assistant scene opens on.
 *
 * Also here: the geometry every cursor aim comes from (the building blocks'
 * own layout helpers, never hand-measured pixels) and the few effects that
 * run ACROSS a cut, which read the film clock so both sides of the cut agree.
 */

/* ── Sizing shared by the three scenes ──────────────────────────────────── */

/**
 * The AI dock: the product's 380px column (AiChatPanel.module.css:19) at a
 * film zoom that puts its 13px bubbles at ≥17 world px (spec §5).
 */
export const DOCK_ZOOM = 1.32;
export const DOCK_W = 380 * DOCK_ZOOM;

/** The portrait AI sheet: 13px bubbles at ≈30 canvas px (spec §6). */
export const SHEET_ZOOM = 1.16;
/**
 * Portrait AI sheet height (stage units). Tall enough for the product's empty
 * state with one suggestion while the prompt is typed; its top edge (740 −
 * 524 = 216) falls between the message body and the gallery, so the whole
 * opening — the three-line stock body, then the rewritten two lines — stays in
 * view above it while the AI works.
 */
export const AI_SHEET_H = 524;
/**
 * The same sheet once the AI's edit lands: the rewrite shortens the body to
 * two lines, so the gallery rises to 204 and a 216 edge would slice a strip of
 * it. The sheet grows 17 units in the frame the body reflows (S05Assistant),
 * putting the edge at 199 — mid-gap between the two-line body (ends 194.5)
 * and the gallery — and keeps that height until it leaves.
 */
export const AI_SHEET_H_APPLIED = 541;

/**
 * The product opens/closes the AI column (and its phone card) and reflows the
 * grid with ONE 260 ms cubic-bezier(0.4, 0, 0.2, 1) (AiChatPanel.module.css:29,
 * global.css:192) — the film uses the same curve, so the preview reflows in
 * step with the dock exactly as the app does.
 */
export const PRODUCT_EASE = Easing.bezier(0.4, 0, 0.2, 1);
/** 260 ms at 30 fps. */
export const DOCK_FRAMES = 8;

/**
 * Portrait scroll positions the three scenes share. The builder sheet's tree
 * is pre-scrolled to the button family (Action row → Enter giveaway) while the
 * AI sheet covers it, so the plugins scene reveals it ready to tap: both of
 * the tree viewport's edges fall between rows. The preview scroll puts both
 * button rows above the builder sheet, whose edge falls in the gap before the
 * select — where the gold attach glow and the delivered card are seen.
 */
export const TREE_V_PRE = 152;
export const PREVIEW_V = 53;

/* ── Motion helpers ─────────────────────────────────────────────────────── */

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** 0→1 over [start, start + dur) with an ease; exactly 0 before and 1 after. */
export const ramp = (frame: number, start: number, dur: number, ease: (t: number) => number = PRODUCT_EASE) =>
  frame <= start ? 0 : frame >= start + dur ? 1 : ease((frame - start) / dur);

/** 0→1→0: rises over `rise` from `start`, holds, and is back at 0 at `end` after a `fall`. */
export const pulse = (frame: number, start: number, end: number, rise = 6, fall = 12) =>
  frame <= start || frame >= end ? 0 : Math.min(1, (frame - start) / rise, (end - frame) / fall);

/** A spring 0→1 from `start` (scene frames), snapped to exactly 1 once settled. */
export const springAt = (
  frame: number,
  start: number,
  config: { damping?: number; mass?: number; stiffness?: number } = {},
) =>
  frame < start ? 0 : settle(spring({ frame: frame - start, fps: FPS, config: { damping: 16, mass: 0.6, stiffness: 130, ...config } }));

/**
 * One sound effect at a scene frame, for its full length. Keep `from` at or
 * after the scene's first visible frame (an invisible layer isn't mounted, so
 * earlier audio would be dropped) and its end before the scene's (its
 * Sequence stops on the next cut); a sound that rings across a cut belongs in
 * the film's SFX track (src/sfxTrack.tsx). `volume` may be a per-frame function.
 */
export const Sfx: React.FC<{ from: number; src: string; frames: number; volume: number | ((f: number) => number) }> = ({
  from,
  src,
  frames,
  volume,
}) => (
  <Sequence from={from} durationInFrames={frames}>
    <Audio src={staticFile(src)} volume={volume} />
  </Sequence>
);

/* ── Landscape geometry (world px) ──────────────────────────────────────── */

const K = EDITOR_L.k;
type Bar = Omit<EditorActionBarProps, "width">;
type TreeOpts = { editor?: TreeEditorSlot | null; reveal?: Record<string, number>; scroll?: number };

/** Landscape: centre of an action-bar control. */
export function barL(control: "send" | "channel", bar: Bar = {}) {
  const g = editorWindowGeometry({ leftWidth: EDITOR_L.leftWidth, k: K, bar, meta: {} });
  const p = g.bar[control]!;
  return { x: EDITOR_L.x + p.x, y: EDITOR_L.y + p.y };
}

/** Landscape: a tree row's box — left x, top, vertical centre, height, and the pane's right edge. */
export function treeRowL(state: CampaignState, id: string, opts: TreeOpts = {}) {
  const g = editorWindowGeometry({ leftWidth: EDITOR_L.leftWidth, k: K, meta: {}, treeScroll: opts.scroll ?? 0 });
  const b = treeLayout(campaignRows(state), campaignAdders(state), { k: K, editor: opts.editor, reveal: opts.reveal }).box(id);
  if (!b) throw new Error(`treeRowL: no row "${id}"`);
  const top = EDITOR_L.y + g.tree.y + b.y;
  return { left: EDITOR_L.x + g.tree.x + b.x, right: EDITOR_L.x + g.tree.x + g.tree.width, top, cy: top + b.h / 2, h: b.h };
}

/**
 * The preview pane's content box (world px): the pane's own 28px padding
 * (×k) inside the window's 1px border and the 44+1 browser chrome — exactly
 * where the EditorWindow lays the message.
 */
export const PANE_L = {
  left: EDITOR_L.x + 1 + EDITOR_L.leftWidth,
  top: EDITOR_L.y + 1 + 45,
  right: EDITOR_L.x + 1 + EDITOR_L.width,
  bottom: EDITOR_L.y + 1 + EDITOR_L.height,
  pad: 28 * K,
} as const;

/** Landscape: the preview card's top-left (world px) while the dock narrows the pane by `shrink`. */
export function previewCardL(shrink = 0) {
  const inner = PANE_L.right - PANE_L.left - 2 * PANE_L.pad - shrink;
  const w = Math.min(EDITOR_L.previewMaxW, inner);
  return { x: PANE_L.left + PANE_L.pad + (inner - w) / 2, y: PANE_L.top + PANE_L.pad, w };
}

/** Landscape: the sparkle FAB (PreviewFabs, pinned 20px×k into the pane's bottom-right). */
export const FAB_L = { x: PANE_L.right - 20 * K - 21 * K, y: PANE_L.bottom - 20 * K - 21 * K } as const;

/** Landscape: the AI dock's own controls, from AssistantPanel's metrics at DOCK_ZOOM. */
export function dockL() {
  const z = DOCK_ZOOM;
  return {
    left: PANE_L.right - DOCK_W,
    /** Composer send button (38px, 14px right / 12px bottom padding). */
    send: { x: PANE_L.right - (14 + 19) * z, y: PANE_L.bottom - (12 + 19) * z },
  };
}

/* ── Portrait geometry (world px) ───────────────────────────────────────── */

/** The portrait editor's top-left in the world (PORTRAIT_STAGE + PORTRAIT_UI). */
export const PORTRAIT_ORIGIN = { x: PORTRAIT_STAGE.x + PORTRAIT_UI.side, y: PORTRAIT_STAGE.y + PORTRAIT_UI.top } as const;
/** The portrait editor surface: 520 × 740 units; content sits inside its 1px border. */
export const PORTRAIT_SIZE = { w: PORTRAIT_STAGE.w - 2 * PORTRAIT_UI.side, h: PORTRAIT_UI.bottom - PORTRAIT_UI.top } as const;
/** Bottom of the portrait editor's content box (world y). */
export const PORTRAIT_BOTTOM = PORTRAIT_ORIGIN.y + PORTRAIT_SIZE.h - 1;

export function barV(control: "send" | "channel", bar: Bar = {}) {
  return portraitEditorGeometry({ ...EDITOR_V, bar }).bar[control]!;
}

/** Portrait: a tree row inside the builder sheet (world px). */
export function treeRowV(state: CampaignState, id: string, opts: TreeOpts = {}) {
  const g = portraitEditorGeometry({ ...EDITOR_V, treeScroll: opts.scroll ?? 0 });
  const b = treeLayout(campaignRows(state), campaignAdders(state), { k: EDITOR_V.k, editor: opts.editor, reveal: opts.reveal }).box(id);
  if (!b) throw new Error(`treeRowV: no row "${id}"`);
  const top = g.tree.y + b.y;
  return { left: g.tree.x + b.x, right: g.tree.x + g.tree.width, top, cy: top + b.h / 2, h: b.h };
}

/** Portrait: the preview card's top-left (world px) at a preview scroll; the card is 496 units wide. */
export function previewCardV(scroll = 0) {
  const g = portraitEditorGeometry({ ...EDITOR_V, previewScroll: scroll });
  return { x: g.preview.x, y: g.preview.y, w: PORTRAIT_SIZE.w - 24 };
}

/** Portrait: the AI sheet's composer send button (the sheet is flush with the editor's bottom). */
export function aiSheetV() {
  const z = SHEET_ZOOM;
  const right = PORTRAIT_ORIGIN.x + 1 + PORTRAIT_SIZE.w - 2;
  return {
    top: PORTRAIT_BOTTOM - AI_SHEET_H,
    send: { x: right - (14 + 19) * z, y: PORTRAIT_BOTTOM - (12 + 19) * z },
  };
}

/* ── The frame ──────────────────────────────────────────────────────────── */

export type ActTree = {
  selected?: string | null;
  editor?: TreeEditorSlot | null;
  reveal?: Record<string, number>;
  highlight?: Record<string, number>;
  hover?: string | null;
  pressed?: string | null;
  scroll?: number;
};

export type ActPreview = Omit<CampaignPreviewProps, "state" | "stage" | "maxWidth" | "time"> & { scroll?: number };

export type AiPanel = Omit<AssistantPanelProps, "reveal" | "layout" | "zoom" | "height" | "width">;

export type ActFrameProps = {
  state: CampaignState;
  /** Stat-pill flourishes on top of campaignStats(state). */
  pills?: { ok?: number; tick?: { components?: number; chars?: number } };
  bar?: Bar;
  tree?: ActTree;
  preview?: ActPreview;
  /** Hides the preview's message (the send flight carries its own copy). */
  previewHidden?: boolean;
  /** The AI assistant: 0..1 slide (landscape dock / portrait sheet), its content, and (portrait) the sheet height. */
  ai?: { reveal: number; panel: AiPanel; height?: number } | null;
  /** 0..1 fade of the whole editor (the send flight dissolves it). */
  opacity?: number;
  /* landscape */
  /** The sparkle FAB's press (the assistant beat opens the dock from it). */
  sparklePressed?: boolean;
  /** Whole-window overlay (the "Add an action" dialog, the Send popover). */
  overlay?: React.ReactNode;
  /* portrait */
  /**
   * The builder sheet's detent (surface units). Default EDITOR_V.sheetTop,
   * where it rests from the template pick on; only the templates scene, which
   * opens on cut A's higher detent, passes another (contracts.ts).
   */
  sheetTop?: number;
  /** A bottom sheet over the editor ("Add an action", "Send message"). */
  sheet?: React.ReactNode;
  scrim?: number;
  /**
   * Drawn in the preview's own layer, positioned from the message's top-left
   * (e.g. a PingRing round a control): it scrolls with the message and stays
   * under the builder sheet. Leave it unset at a cut — the rest frame's
   * preview is the bare message.
   */
  previewOverlay?: React.ReactNode;
  /** PortraitEditor assembly (0..1 per part) — the send flight slides the builder sheet away. */
  assembly?: { surface?: number; bar?: number; sheet?: number };
};

const fade = (opacity: number | undefined): React.CSSProperties | undefined =>
  opacity !== undefined && opacity < 1 ? { opacity: Math.max(0, opacity) } : undefined;

/** The landscape editor window at its contract position (world 120, 90). */
export const LandscapeAct: React.FC<ActFrameProps> = ({
  state,
  pills,
  bar,
  tree = {},
  preview = {},
  previewHidden = false,
  ai,
  opacity,
  sparklePressed,
  overlay,
}) => {
  const stats = campaignStats(state);
  const open = ai?.reveal ?? 0;
  const shrink = open * DOCK_W;
  const { scroll: previewScroll = 0, ...previewProps } = preview;
  const message = <CampaignPreview state={state} maxWidth={EDITOR_L.previewMaxW} {...previewProps} />;
  // At rest the message is the pane's direct child — the exact tree cut B
  // has. While the dock is in, the column narrows by the dock's width and the
  // message re-centres in what is left, as the product's grid does.
  const previewNode =
    shrink > 0.01 || previewHidden ? (
      <div
        style={{
          width: "100%",
          boxSizing: "border-box",
          paddingRight: shrink > 0.01 ? shrink : undefined,
          display: "flex",
          justifyContent: "center",
          visibility: previewHidden ? "hidden" : undefined,
        }}
      >
        {message}
      </div>
    ) : (
      message
    );
  return (
    <div style={{ position: "absolute", left: EDITOR_L.x, top: EDITOR_L.y, ...fade(opacity) }}>
      <EditorWindow
        width={EDITOR_L.width}
        height={EDITOR_L.height}
        leftWidth={EDITOR_L.leftWidth}
        k={EDITOR_L.k}
        dk={EDITOR_L.dk}
        bar={{ channel: null, canUndo: true, canRedo: false, ...bar }}
        meta={{ ...stats, ok: pills?.ok, tick: pills?.tick }}
        tree={
          <CampaignTree
            state={state}
            adders
            selected={tree.selected ?? null}
            editor={tree.editor ?? null}
            reveal={tree.reveal}
            highlight={tree.highlight}
            hover={tree.hover ?? null}
            pressed={tree.pressed ?? null}
          />
        }
        treeScroll={tree.scroll ?? 0}
        preview={previewNode}
        previewScroll={previewScroll}
        // The product's FAB stack is fixed to the viewport's bottom-right, so
        // the docked AI column slides OVER it (and back off it on close).
        fabs={sparklePressed ? <PreviewFabs sparklePressed /> : true}
        previewOverlay={
          open > 0.001 && ai ? (
            <div style={{ position: "absolute", top: 0, right: 0, bottom: 0, width: DOCK_W, zIndex: 12 }}>
              <AssistantPanel {...ai.panel} reveal={open} layout="dock" zoom={DOCK_ZOOM} />
            </div>
          ) : undefined
        }
        overlay={overlay}
      />
    </div>
  );
};

/** The portrait editor at its stage position (world 700, 260). */
export const PortraitAct: React.FC<ActFrameProps> = ({
  state,
  pills,
  bar,
  tree = {},
  preview = {},
  previewHidden = false,
  ai,
  opacity,
  sheetTop = EDITOR_V.sheetTop,
  sheet,
  scrim = 0,
  previewOverlay,
  assembly,
}) => {
  const stats = campaignStats(state);
  const { scroll: previewScroll = 0, ...previewProps } = preview;
  const message = <CampaignPreview state={state} {...previewProps} />;
  const shown = previewHidden ? <div style={{ visibility: "hidden" }}>{message}</div> : message;
  const aiOpen = ai?.reveal ?? 0;
  return (
    <div style={{ position: "absolute", left: PORTRAIT_ORIGIN.x, top: PORTRAIT_ORIGIN.y, ...fade(opacity) }}>
      <PortraitEditor
        k={EDITOR_V.k}
        barK={EDITOR_V.barK}
        dk={EDITOR_V.dk}
        sheetTop={sheetTop}
        bar={{ channel: null, canUndo: true, canRedo: false, ...bar }}
        preview={
          previewOverlay ? (
            <div style={{ position: "relative" }}>
              {shown}
              {previewOverlay}
            </div>
          ) : (
            shown
          )
        }
        previewScroll={previewScroll}
        pills={{ ...stats, ok: pills?.ok, tick: pills?.tick }}
        tree={
          <CampaignTree
            state={state}
            adders
            selected={tree.selected ?? null}
            editor={tree.editor ?? null}
            reveal={tree.reveal}
            highlight={tree.highlight}
            hover={tree.hover ?? null}
            pressed={tree.pressed ?? null}
          />
        }
        treeScroll={tree.scroll ?? 0}
        // The phone's assistant floats over the lower screen with no scrim:
        // the message render stays fully visible while it works
        // (global.css:494-497). The other sheets dim the editor behind them.
        sheet={
          aiOpen > 0.001 && ai ? (
            <AssistantPanel {...ai.panel} reveal={aiOpen} layout="sheet" zoom={SHEET_ZOOM} height={ai.height ?? AI_SHEET_H} />
          ) : (
            sheet
          )
        }
        scrim={scrim}
        assembly={assembly}
      />
    </div>
  );
};

/* ── Emphasis ───────────────────────────────────────────────────────────── */

/** A box in the message's own px (from its top-left), with the control's corner radius. */
export type MessageBox = { x: number; y: number; w: number; h: number; r: number };

/**
 * One ring rippling out from a control's outline, for `t` 0 → 1: the "look
 * here" for something that has just come into view — the click ripple's
 * language (Cursor), drawn round the control instead of out from a tip.
 * Grows GROW px while it fades; nothing renders outside (0, 1).
 */
export const PingRing: React.FC<{ box: MessageBox; t: number; color: string; grow?: number }> = ({ box, t, color, grow = 14 }) => {
  if (!(t > 0 && t < 1)) return null;
  const g = grow * (1 - (1 - t) ** 3);
  const stroke = 2.5;
  return (
    <div
      style={{
        position: "absolute",
        left: box.x - g - stroke,
        top: box.y - g - stroke,
        width: box.w + 2 * (g + stroke),
        height: box.h + 2 * (g + stroke),
        boxSizing: "border-box",
        borderRadius: box.r + g + stroke,
        border: `${stroke}px solid ${color}`,
        opacity: 0.9 * (1 - t) ** 1.4,
        pointerEvents: "none",
      }}
    />
  );
};

/* ── The message on its own (the send flight's shared element) ──────────── */

/**
 * The preview card outside the editor, at a world position, drawn with the
 * same components and zoom as the editor's preview — so the frame it takes
 * over from the editor's own copy is pixel-identical, and it can then lift,
 * fly and land in Discord. `lift` 0..1 raises it (scale + shadow).
 */
export const FloatingCard: React.FC<{
  x: number;
  y: number;
  width: number;
  dk: number;
  lift?: number;
  scale?: number;
  opacity?: number;
  /** World-y band the card shows through (the portrait take-over: under the bar, above the sheet). */
  clip?: { top: number; bottom: number };
  preview: CampaignPreviewProps;
}> = ({ x, y, width, dk, lift = 0, scale = 1, opacity, clip, preview }) => {
  const l = clamp01(lift);
  const s = scale * (1 + 0.025 * l);
  if (clip) {
    return (
      <div style={{ position: "absolute", left: 0, right: 0, top: clip.top, height: Math.max(0, clip.bottom - clip.top), overflow: "hidden", zIndex: 20 }}>
        <FloatingCard x={x} y={y - clip.top} width={width} dk={dk} lift={lift} scale={scale} opacity={opacity} preview={preview} />
      </div>
    );
  }
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width,
        zIndex: 20,
        transformOrigin: "50% 30%",
        transform: s !== 1 ? `scale(${s.toFixed(4)})` : undefined,
        filter: l > 0.01 ? `drop-shadow(0 ${(26 * l).toFixed(1)}px ${(40 * l).toFixed(1)}px rgba(0,0,0,${(0.55 * l).toFixed(3)}))` : undefined,
        ...fade(opacity),
      }}
    >
      <DiscordScale k={dk}>
        <CampaignPreview {...preview} maxWidth={width} />
      </DiscordScale>
    </div>
  );
};
