import {
  WINDOW_CHROME_H,
  editorWindowGeometry,
  metaFootprint,
  paneTreeOrigin,
  portraitEditorGeometry,
  treeLayout,
  type TreeEditorSlot,
} from "../../components/editor";
import { campaignAdders, campaignRows, type CampaignState } from "../../story/campaign";
import { EDITOR_L, EDITOR_V } from "../contracts";

/**
 * World-space geometry of the editor act's tree, derived from the SAME layout
 * functions the renderer uses (editorWindowGeometry / portraitEditorGeometry +
 * treeLayout), so every cursor aim lands on the pixels it names. Also the
 * insides of the inline editors and the add menu, from their CSS metrics.
 */

export type Box = { x: number; y: number; w: number; h: number; cx: number; cy: number };

type TreeOpts = { editor?: TreeEditorSlot | null; reveal?: Record<string, number>; scroll?: number };

/** Landscape: the tree's origin and width in world px (window at EDITOR_L.x/y). */
export function treeOriginL(scroll = 0) {
  const g = editorWindowGeometry({ leftWidth: EDITOR_L.leftWidth, k: EDITOR_L.k, meta: {}, treeScroll: scroll });
  return { x: EDITOR_L.x + g.tree.x, y: EDITOR_L.y + g.tree.y, w: g.tree.width };
}

/** Portrait: the tree's origin and width in world px (editor at the stage spot). */
export function treeOriginV(scroll = 0) {
  const g = portraitEditorGeometry({ ...EDITOR_V, treeScroll: scroll });
  return { x: g.tree.x, y: g.tree.y, w: g.tree.width };
}

/** Landscape / portrait: a tree row, adder or open editor's box (world px). */
export function treeBox(vertical: boolean, state: CampaignState, id: string, opts: TreeOpts = {}): Box {
  const k = vertical ? EDITOR_V.k : EDITOR_L.k;
  const o = vertical ? treeOriginV(opts.scroll) : treeOriginL(opts.scroll);
  const tl = treeLayout(campaignRows(state), campaignAdders(state), { k, editor: opts.editor, reveal: opts.reveal });
  const b = tl.box(id);
  if (!b) throw new Error(`treeBox: no "${id}" in the ${vertical ? "portrait" : "landscape"} tree`);
  // Rows and editors span to the tree's right edge; adders hug their label.
  const w = o.w - b.x;
  return { x: o.x + b.x, y: o.y + b.y, w, h: b.h, cx: o.x + b.x + w / 2, cy: o.y + b.y + b.h / 2 };
}

/**
 * Landscape: the MetaHeader's stat pills' top-left in EditorWindow-local px
 * (inside the window's 1px border — the `overlay` layer's space). The
 * header's box sits right above the tree origin; the pills are inset by its
 * own 8px top / 4px left padding (Meta.tsx MetaHeader). LandscapeAct passes
 * no fields/options, hence `{}`.
 */
export function pillsWindowL(k: number) {
  const tree = paneTreeOrigin(k, {});
  return { x: tree.x + 4 * k, y: WINDOW_CHROME_H + 1 + tree.y - metaFootprint({}) * k + 8 * k };
}

/**
 * Portrait: the stat pills' top-left in surface-local px (SurfaceOverlayV's
 * space), in the builder sheet's header (Layouts.tsx PortraitSheet): under
 * the sheet's 1px top border, 8px padding, the 5px grabber and its 10px
 * margin; 10px sheet padding + the pills row's own 4px (unzoomed) at the left.
 */
export function pillsSurfaceV(sheetTop: number, k: number) {
  return { x: 10 * k + 4, y: sheetTop + 1 + (8 + 5 + 10) * k };
}

/** Width of a dashed "+ Add …" adder pill at zoom k (TreeAdder: 5 + 16 + 7 gaps, 13px label, 13 right). */
export const adderWidth = (label: string, k: number) => k * (5 + 16 + 7 + 13 + label.length * 13 * 0.56);

/* ── Inside the Text inline editor (InlineEditors.tsx TextInlineEditor) ──── */

/**
 * Offsets inside the Text editor slot at zoom k: frame border 1 + padding 14,
 * "Content" label 18 + gap 6, the toolbar (1 + 4 + 30 + 4), then the textarea's
 * 1px border + 10px top / 12px left padding. Line height 1.55 × 14px.
 */
export const TEXT_EDITOR = {
  line1Top: 89,
  lineH: 14 * 1.55,
  /** 3px accent bar + 14 padding + 1 border + 12 padding. */
  textLeft: 30,
  fontPx: 14,
} as const;

/** World point on the textarea's first line (the heading), `dx` world px from the text start. */
export function headingLinePoint(editor: Box, k: number, dx: number) {
  return {
    x: editor.x + TEXT_EDITOR.textLeft * k + dx,
    y: editor.y + (TEXT_EDITOR.line1Top + TEXT_EDITOR.lineH / 2) * k,
  };
}

/* ── Inside the Media gallery inline editor (GalleryInlineEditor) ────────── */

/**
 * The drop zone's centre inside the gallery editor slot: border 1 + padding 14,
 * the "Media (3 / 10) · + Add media" row (~15.6), a 10px gap, then the zone
 * (2×14 padding + two text lines + 3 gap + 1.5px borders ≈ 64 tall).
 */
export function dropZone(editor: Box, k: number): Box {
  const top = editor.y + (1 + 14 + 15.6 + 10) * k;
  const h = 64 * k;
  const x = editor.x + (3 + 14) * k;
  const w = editor.w - (3 + 14 + 14 + 1) * k;
  return { x, y: top, w, h, cx: x + w / 2, cy: top + h / 2 };
}

/* ── The add menu (editor/AddMenu.tsx at the product's metrics) ─────────── */

/**
 * AddComponentMenu rows, in menu-local px at zoom k: 1px border, 10px list
 * padding, three shelves (title 8 + ~13.4 + 4, rows 38, 6px after each
 * shelf). "Buttons & menus" expands to six children.
 */
export function addMenuRows(k: number) {
  const title = (8 + 11 * 1.22 + 4) * k;
  const row = 38 * k;
  const shelfGap = 6 * k;
  let y = (1 + 10) * k;
  y += title + 2 * row + shelfGap; // STRUCTURE: Section, Separator
  y += title + 3 * row + shelfGap; // CONTENT: Text, Media gallery, File
  const interactiveTop = y;
  y += title;
  const group = y + row / 2; // "Buttons & menus"
  return {
    row,
    interactiveTop,
    buttonsMenus: group,
    button: group + row,
    optionsMenu: group + 2 * row,
    /** Natural height collapsed / with the group expanded. */
    collapsedH: y + row + shelfGap + (10 + 1) * k,
    expandedH: y + 7 * row + shelfGap + (10 + 1) * k,
  };
}
