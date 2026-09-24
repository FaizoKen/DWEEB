import React from "react";
import { COLORS } from "../../theme";
import { INTER } from "../../fonts";
import { AppWindow, type WindowAssembly } from "../AppUI";
import { EditorActionBar, actionBarAnchors, actionBarPlan, type EditorActionBarProps } from "./ActionBar";
import { MetaHeader, StatPills } from "./Meta";
import { PIcon } from "./ProductIcon";
import { DiscordScale, UiScale, useUi } from "./scale";

/**
 * Editor compositions. One component per layout so the hold cuts are
 * guaranteed by construction: feed identical props on both sides of a cut and
 * the pixels are identical.
 *
 *  EditorWindow   — landscape: browser window, builder pane (action bar,
 *                   MetaHeader pills, tree), preview pane, overlays.
 *  PortraitEditor — the 9:16 portrait stage (540×960 world units, filmed at
 *                   s = 2): an app surface with the bar strip on top, the live
 *                   preview, and the builder bottom sheet; sheets for the AI,
 *                   "Add an action" and "Send message" slide over it.
 * Geometry helpers return the positions the renderer uses, for cursor aims.
 */

export type MetaProps = {
  components: number;
  chars: number;
  ok?: number;
  tick?: { components?: number; chars?: number };
  fields?: boolean;
  options?: boolean;
};

/* ── Builder pane ───────────────────────────────────────────────────────── */

/** Scroll padding of the tree area (ComponentTree .scroll: 10px). */
const PANE_PAD = 10;
const BAR_H = 52;

/** Height at k = 1 of the MetaHeader box incl. its 12px bottom margin. */
export function metaFootprint(meta: Pick<MetaProps, "fields" | "options"> | null | undefined) {
  if (!meta) return 0;
  return 48 + 1 + (meta.fields ? 72 : 0) + (meta.options ? 64 : 0) + 12;
}

/** Where the tree's top-left sits inside the builder pane (world px). */
export function paneTreeOrigin(k: number, meta?: Pick<MetaProps, "fields" | "options"> | null, scrollY = 0) {
  return { x: PANE_PAD * k, y: BAR_H * k + PANE_PAD * k + metaFootprint(meta) * k - scrollY };
}

export const EditorPane: React.FC<{
  width: number;
  height: number;
  bar: Omit<EditorActionBarProps, "width">;
  meta?: MetaProps | null;
  tree: React.ReactNode;
  /** Scroll offset of the tree area (world px). */
  scrollY?: number;
  /** The floating "+ Add component" pill bottom-left (off by default: captions live there). */
  fab?: boolean;
  /** Anything positioned in pane coordinates (e.g. the add menu). */
  children?: React.ReactNode;
}> = ({ width, height, bar, meta, tree, scrollY = 0, fab = false, children }) => {
  const { u } = useUi();
  return (
    <div style={{ position: "relative", width, height, overflow: "hidden", background: COLORS.bg, fontFamily: INTER }}>
      <EditorActionBar width={width} {...bar} />
      <div style={{ position: "absolute", left: 0, right: 0, top: u(BAR_H), bottom: 0, overflow: "hidden" }}>
        <div style={{ padding: u(PANE_PAD), transform: scrollY ? `translateY(${-scrollY}px)` : undefined }}>
          {meta && (
            <div style={{ height: u(metaFootprint(meta) - 12), marginBottom: u(12), overflow: "hidden" }}>
              <MetaHeader {...meta} />
            </div>
          )}
          {tree}
        </div>
      </div>
      {fab && (
        <div
          style={{
            position: "absolute",
            left: u(16),
            bottom: u(16),
            display: "flex",
            alignItems: "center",
            gap: u(8),
            height: u(42),
            padding: `0 ${u(18)}px`,
            borderRadius: 999,
            background: COLORS.blurple,
            color: "#fff",
            fontSize: u(14),
            fontWeight: 600,
            boxShadow: "0 16px 48px rgba(0,0,0,0.6)",
          }}
        >
          <PIcon name="plus" size={u(16)} />
          Add component
        </div>
      )}
      {children}
    </div>
  );
};

/* ── Preview pane ───────────────────────────────────────────────────────── */

/** The preview's two floating buttons (Collab pill + the AI sparkle), bottom-right. */
export const PreviewFabs: React.FC<{ sparkleHover?: boolean; sparklePressed?: boolean }> = ({ sparkleHover, sparklePressed }) => {
  const { u } = useUi();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: u(12) }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: u(8),
          height: u(42),
          padding: `0 ${u(18)}px`,
          borderRadius: 999,
          background: COLORS.blurple,
          color: "#fff",
          fontFamily: INTER,
          fontSize: u(14),
          fontWeight: 600,
          boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
        }}
      >
        <PIcon name="users" size={u(18)} />
        Collab
      </div>
      <div
        style={{
          width: u(42),
          height: u(42),
          borderRadius: "50%",
          background: "linear-gradient(135deg, #c026d3, #eb459e)",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: sparkleHover ? "0 0 0 3px rgba(235,69,158,0.45), 0 16px 48px rgba(0,0,0,0.5)" : "0 16px 48px rgba(0,0,0,0.5)",
          transform: sparklePressed ? "scale(0.92)" : undefined,
        }}
      >
        <PIcon name="sparkle" size={u(20)} />
      </div>
    </div>
  );
};

export const PreviewPane: React.FC<{
  children: React.ReactNode;
  /** Padding around the message (world px at the current zoom). */
  padding?: number;
  align?: "center" | "start";
  scrollY?: number;
  fabs?: boolean | React.ReactNode;
  overlay?: React.ReactNode;
}> = ({ children, padding, align = "center", scrollY = 0, fabs = true, overlay }) => {
  const { u } = useUi();
  const pad = padding ?? u(28);
  return (
    <div style={{ position: "relative", flex: 1, alignSelf: "stretch", minWidth: 0, background: COLORS.dBgPrimary, overflow: "hidden" }}>
      <div
        style={{
          padding: pad,
          display: "flex",
          justifyContent: align === "center" ? "center" : "flex-start",
          transform: scrollY ? `translateY(${-scrollY}px)` : undefined,
        }}
      >
        {children}
      </div>
      {fabs && (
        <div style={{ position: "absolute", right: u(20), bottom: u(20) }}>{fabs === true ? <PreviewFabs /> : fabs}</div>
      )}
      {overlay}
    </div>
  );
};

/* ── Landscape window ───────────────────────────────────────────────────── */

export type EditorWindowProps = {
  width?: number;
  height?: number;
  leftWidth?: number;
  /** App-chrome zoom (UiScale). */
  k?: number;
  /** Discord-preview zoom (DiscordScale). */
  dk?: number;
  assembly?: WindowAssembly;
  bar: Omit<EditorActionBarProps, "width">;
  meta?: MetaProps | null;
  tree: React.ReactNode;
  treeScroll?: number;
  /** Anything in builder-pane coordinates (the add menu, a cursor). */
  paneOverlay?: React.ReactNode;
  preview: React.ReactNode;
  previewScroll?: number;
  previewAlign?: "center" | "start";
  previewPadding?: number;
  fabs?: boolean | React.ReactNode;
  /** Preview-pane overlays (e.g. the AI dock, docked to the pane's right edge). */
  previewOverlay?: React.ReactNode;
  /** Whole-window overlays (the directory, a dialog, a backdrop). */
  overlay?: React.ReactNode;
  url?: string;
};

/** Browser chrome height of AppWindow. */
export const WINDOW_CHROME_H = 44;

export const EditorWindow: React.FC<EditorWindowProps> = ({
  width = 1680,
  height = 900,
  leftWidth = 520,
  k = 1,
  dk = 1.12,
  assembly,
  bar,
  meta,
  tree,
  treeScroll = 0,
  paneOverlay,
  preview,
  previewScroll = 0,
  previewAlign = "center",
  previewPadding,
  fabs = true,
  previewOverlay,
  overlay,
  url,
}) => (
  <UiScale k={k}>
    <DiscordScale k={dk}>
      <AppWindow
        width={width}
        height={height}
        url={url}
        leftWidth={leftWidth}
        leftPadding={0}
        leftGap={0}
        rightPadding={0}
        assembly={assembly}
        left={
          <EditorPane width={leftWidth - 1} height={height - WINDOW_CHROME_H - 2} bar={bar} meta={meta} tree={tree} scrollY={treeScroll}>
            {paneOverlay}
          </EditorPane>
        }
        right={
          <PreviewPane align={previewAlign} scrollY={previewScroll} fabs={fabs} padding={previewPadding} overlay={previewOverlay}>
            {preview}
          </PreviewPane>
        }
        overlay={overlay}
      />
    </DiscordScale>
  </UiScale>
);

/**
 * Key positions inside an EditorWindow, relative to its top-left (world px):
 * the action bar's control centres, the tree origin (add treeLayout().box()),
 * and the preview pane's box.
 */
export function editorWindowGeometry(opts: {
  width?: number;
  height?: number;
  leftWidth?: number;
  k?: number;
  bar?: Omit<EditorActionBarProps, "width">;
  meta?: Pick<MetaProps, "fields" | "options"> | null;
  treeScroll?: number;
}) {
  const { width = 1680, height = 900, leftWidth = 520, k = 1, bar = {}, meta = null, treeScroll = 0 } = opts;
  const paneW = leftWidth - 1;
  const plan = actionBarPlan(paneW, k, bar);
  const anchors = actionBarAnchors(plan, paneW, k);
  const barTop = WINDOW_CHROME_H;
  const bars = Object.fromEntries(
    Object.entries(anchors).map(([id, p]) => [id, { x: p!.x, y: barTop + p!.y }]),
  ) as typeof anchors;
  const origin = paneTreeOrigin(k, meta, treeScroll);
  return {
    plan,
    bar: bars,
    tree: { x: origin.x, y: barTop + origin.y, width: paneW - 2 * PANE_PAD * k },
    preview: { x: leftWidth, y: barTop, width: width - leftWidth, height: height - barTop },
  };
}

/* ── Portrait stage ─────────────────────────────────────────────────────── */

/** The portrait stage in world units (spec §6): x 690–1230, y 60–1020, filmed at s = 2. */
export const PORTRAIT_STAGE = { x: 690, y: 60, w: 540, h: 960, s: 2 } as const;
/** Stage-unit bands: the caption band ends ~195; UI from 200 down to ~940. */
export const PORTRAIT_UI = { top: 200, bottom: 940, side: 10 } as const;

export type PortraitEditorProps = {
  k?: number;
  /**
   * The bar's own zoom. At 1.04 the product's fit ladder still keeps Save and
   * the Message directory icon inline on the 518-unit bar (the vertical
   * templates beat taps it); at 1.07 it would fold the directory into ⋯.
   */
  barK?: number;
  dk?: number;
  bar: Omit<EditorActionBarProps, "width">;
  preview: React.ReactNode;
  previewScroll?: number;
  /** Where the builder sheet starts, in surface units (0 = the surface top). */
  sheetTop?: number;
  /** The tree (CampaignTree) inside the builder sheet. */
  tree: React.ReactNode;
  treeScroll?: number;
  /** Stat pills shown in the sheet header. */
  pills?: { components: number; chars: number; ok?: number; tick?: { components?: number; chars?: number } } | null;
  /** A second sheet over everything (AI / Add an action), bottom-anchored. */
  sheet?: React.ReactNode;
  /**
   * A dialog over everything, centred on the surface ("Send message"): the
   * product's phone Modal — a card inset by the backdrop's 16 px, not a sheet.
   */
  modal?: React.ReactNode;
  /** Scrim behind that sheet / dialog, 0..1. */
  scrim?: number;
  /**
   * 0..1 per part, default settled — the vertical reveal builds the editor
   * AROUND the matched card: the preview region (carrying the card) is there
   * from the first frame, the surface frame fades up, the bar drops in, the
   * builder sheet slides up. Settled, it is the exact frame the templates
   * scene opens on.
   */
  assembly?: { surface?: number; bar?: number; sheet?: number };
  /** Anything in surface coordinates (touch indicator, toasts…). */
  overlay?: React.ReactNode;
};

/**
 * The portrait editor surface, laid out in STAGE units: place it at
 * (left: PORTRAIT_STAGE.x + PORTRAIT_UI.side, top: PORTRAIT_STAGE.y + PORTRAIT_UI.top)
 * in the world; it is 520 × 740 units.
 */
export const PortraitEditor: React.FC<PortraitEditorProps> = ({
  k = 1.07,
  barK = 1.04,
  dk = 1.0,
  bar,
  preview,
  previewScroll = 0,
  sheetTop = 470,
  tree,
  treeScroll = 0,
  pills,
  sheet,
  modal,
  scrim = 0,
  assembly,
  overlay,
}) => {
  const W = PORTRAIT_STAGE.w - 2 * PORTRAIT_UI.side;
  const H = PORTRAIT_UI.bottom - PORTRAIT_UI.top;
  const clamp = (v: number | undefined) => Math.max(0, Math.min(1, v ?? 1));
  const surfaceP = clamp(assembly?.surface);
  const barP = clamp(assembly?.bar);
  const sheetP = clamp(assembly?.sheet);
  return (
    <UiScale k={k}>
      <DiscordScale k={dk}>
        <div
          style={{
            position: "relative",
            width: W,
            height: H,
            borderRadius: 18,
            overflow: "hidden",
            background: surfaceP < 1 ? `rgba(14,15,19,${surfaceP.toFixed(3)})` : COLORS.bg,
            border: `1px solid rgba(59,65,80,${surfaceP.toFixed(3)})`,
            boxShadow: `0 30px 90px rgba(0,0,0,${(0.55 * surfaceP).toFixed(3)})`,
            fontFamily: INTER,
          }}
        >
          {barP > 0.001 && (
            <div
              style={{
                opacity: barP,
                transform: barP < 1 ? `translateY(${(1 - barP) * -60}px)` : undefined,
              }}
            >
              <UiScale k={barK}>
                <EditorActionBar width={W - 2} {...bar} />
              </UiScale>
            </div>
          )}
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: BAR_H * barK,
              height: sheetTop - BAR_H * barK + 18,
              background: COLORS.dBgPrimary,
              overflow: "hidden",
            }}
          >
            <div style={{ padding: `${14}px ${12}px`, transform: previewScroll ? `translateY(${-previewScroll}px)` : undefined }}>
              {preview}
            </div>
          </div>
          <PortraitSheet top={sheetTop} height={H - sheetTop} offset={(1 - sheetP) * (H - sheetTop + 40)}>
            {pills && (
              <div style={{ padding: `0 ${4}px ${10}px` }}>
                <StatPills {...pills} />
              </div>
            )}
            <div style={{ position: "relative", flex: 1, minHeight: 0, overflow: "hidden" }}>
              <div style={{ transform: treeScroll ? `translateY(${-treeScroll}px)` : undefined }}>{tree}</div>
            </div>
          </PortraitSheet>
          {scrim > 0.001 && <div style={{ position: "absolute", inset: 0, background: `rgba(0,0,0,${(0.55 * scrim).toFixed(3)})` }} />}
          {sheet && <div style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}>{sheet}</div>}
          {modal && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                boxSizing: "border-box",
                padding: 16 * k,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {modal}
            </div>
          )}
          {overlay}
        </div>
      </DiscordScale>
    </UiScale>
  );
};

/**
 * WORLD coordinates of a PortraitEditor placed at the standard spot
 * (PORTRAIT_STAGE + PORTRAIT_UI): the bar's control centres, the tree's
 * top-left inside the builder sheet (add treeLayout().box()), and the preview's
 * content origin. Multiply offsets from the stage origin by 2 for canvas px.
 */
export function portraitEditorGeometry(opts: {
  k?: number;
  barK?: number;
  sheetTop?: number;
  pills?: boolean;
  treeScroll?: number;
  previewScroll?: number;
  bar?: Omit<EditorActionBarProps, "width">;
}) {
  const { k = 1.07, barK = 1.04, sheetTop = 470, pills = true, treeScroll = 0, previewScroll = 0, bar = {} } = opts;
  const W = PORTRAIT_STAGE.w - 2 * PORTRAIT_UI.side;
  // Inside the surface's 1px border.
  const ox = PORTRAIT_STAGE.x + PORTRAIT_UI.side + 1;
  const oy = PORTRAIT_STAGE.y + PORTRAIT_UI.top + 1;
  const plan = actionBarPlan(W - 2, barK, bar);
  const anchors = actionBarAnchors(plan, W - 2, barK, BAR_H * barK);
  const barWorld = Object.fromEntries(
    Object.entries(anchors).map(([id, p]) => [id, { x: ox + p!.x, y: oy + p!.y }]),
  ) as typeof anchors;
  // Sheet: 8k top padding, 5k grabber + 10k margin, then the pills row (24k + 10).
  const treeTop = sheetTop + 8 * k + 5 * k + 10 * k + (pills ? 24 * k + 10 : 0) - treeScroll;
  return {
    plan,
    bar: barWorld,
    tree: { x: ox + 10 * k, y: oy + treeTop, width: W - 2 - 20 * k },
    preview: { x: ox + 12, y: oy + BAR_H * barK + 14 - previewScroll },
  };
}

/** The builder's bottom sheet inside the PortraitEditor (grabber + content). */
const PortraitSheet: React.FC<{ top: number; height: number; offset?: number; children: React.ReactNode }> = ({
  top,
  height,
  offset = 0,
  children,
}) => {
  const { u } = useUi();
  if (offset >= height + 39) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        top,
        height,
        transform: offset > 0 ? `translateY(${offset}px)` : undefined,
        display: "flex",
        flexDirection: "column",
        padding: `${u(8)}px ${u(10)}px 0`,
        boxSizing: "border-box",
        background: COLORS.bgElevated,
        borderTop: `1px solid ${COLORS.borderStrong}`,
        borderRadius: "18px 18px 0 0",
        boxShadow: "0 -18px 50px rgba(0,0,0,0.45)",
      }}
    >
      <div style={{ alignSelf: "center", width: u(40), height: u(5), borderRadius: 3, background: COLORS.borderStrong, marginBottom: u(10), flexShrink: 0 }} />
      {children}
    </div>
  );
};
