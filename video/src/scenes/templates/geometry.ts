import { EDITOR_L, EDITOR_V } from "../contracts";
import { PORTRAIT_STAGE, PORTRAIT_UI, WINDOW_CHROME_H } from "../../components/editor";
import type { Box } from "../build/geometry";

/**
 * Where the Message directory and the pick toast sit, from the product's CSS
 * (TemplateGallery.module.css, Toast.module.css) at the film's zoom — so the
 * pointer aims at cards the renderer actually draws there.
 */

const box = (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h, cx: x + w / 2, cy: y + h / 2 });

/* ── Landscape: the overlay inside the EditorWindow ─────────────────────── */

const KL = EDITOR_L.k;

/**
 * The page area below the browser chrome, in window-local px (the overlay's
 * coordinate space: inside the window's 1px border, under the 44px chrome and
 * its 1px hairline).
 */
export const PAGE_L = {
  top: WINDOW_CHROME_H + 1,
  width: EDITOR_L.width - 2,
  height: EDITOR_L.height - 2 - WINDOW_CHROME_H - 1,
};

/**
 * .panel: width min(1240px, 100%), height min(940px, 100%) inside the
 * backdrop's 24px padding, centred.
 */
export const PANEL_L = (() => {
  const pad = 24 * KL;
  const w = Math.min(1240 * KL, PAGE_L.width - 2 * pad);
  const h = Math.min(940 * KL, PAGE_L.height - 2 * pad);
  const left = (PAGE_L.width - w) / 2;
  const top = PAGE_L.top + (PAGE_L.height - h) / 2;
  return { left, top, w, h };
})();

/** The panel's rect in world px. */
export const panelWorldL = (): Box => box(EDITOR_L.x + 1 + PANEL_L.left, EDITOR_L.y + 1 + PANEL_L.top, PANEL_L.w, PANEL_L.h);

/**
 * Header height (overlay layout): 16 top + title block (28px icon row, 4 gap,
 * a two-line 13px/1.45 subtitle) + 10 + the explore links (13px) + 10 + the
 * 40px search row + 14 bottom + 1px hairline.
 */
const HEADER_L = (16 + (28 + 4 + 2 * 13 * 1.45) + 10 + 13 * 1.22 + 10 + 40 + 14 + 1) * KL;
/** Card: border, 196 preview + hairline, body (13 + 20 + 7 + two 13/1.45 lines + 7 + 23 + 14), border. */
const CARD_L = (1 + 196 + 1 + (13 + 20 + 7 + 2 * 13 * 1.45 + 7 + 23 + 14) + 1) * KL;
const GRID_PAD_L = { x: 24 * KL, y: 22 * KL };
const GRID_GAP_L = 18 * KL;
export const DIRECTORY_COLUMNS_L = 4;

/** A card's rect (world px) at grid row r, column c; `preview` is its live-preview area. */
export function cardWorldL(r: number, c: number) {
  const p = panelWorldL();
  const gridW = p.w - 2 * KL - 2 * GRID_PAD_L.x;
  const w = (gridW - (DIRECTORY_COLUMNS_L - 1) * GRID_GAP_L) / DIRECTORY_COLUMNS_L;
  const x = p.x + KL + GRID_PAD_L.x + c * (w + GRID_GAP_L);
  const y = p.y + KL + HEADER_L + GRID_PAD_L.y + r * (CARD_L + GRID_GAP_L);
  const card = box(x, y, w, CARD_L);
  const preview = box(x + KL, y + KL, w - 2 * KL, 196 * KL);
  return { card, preview };
}

/** ui/Toast in the landscape page: fixed top-right, 16px in, 360px max wide. */
export const TOAST_L = { right: 16 * KL, top: PAGE_L.top + 16 * KL, maxWidth: 360 };

/* ── Portrait: the directory as a bottom sheet in the PortraitEditor ────── */

const KV = EDITOR_V.k;

/** Inner size of the portrait surface (inside its 1px border). */
export const SURFACE_V = {
  w: PORTRAIT_STAGE.w - 2 * PORTRAIT_UI.side - 2,
  h: PORTRAIT_UI.bottom - PORTRAIT_UI.top - 2,
  /** World position of the inner top-left. */
  x: PORTRAIT_STAGE.x + PORTRAIT_UI.side + 1,
  y: PORTRAIT_STAGE.y + PORTRAIT_UI.top + 1,
};

/** The sheet starts right under the action bar (52 × barK). */
export const SHEET_V = { top: Math.round(52 * EDITOR_V.barK), height: SURFACE_V.h - Math.round(52 * EDITOR_V.barK) };

/** Card preview height in the portrait sheet (product mobile: 184; tighter so a second card peeks). */
export const PREVIEW_H_V = 150;

/**
 * Sheet header (sheet layout): grabber (8 + 5), 10 top padding, title block
 * (28 icon row + 4 + two subtitle lines), 10 gap, the 40px search, 12 bottom,
 * 1px hairline — all at zoom k.
 */
const GRABBER_V = (8 + 5) * KV;
const HEADER_V = (10 + (28 + 4 + 2 * 13 * 1.45) + 10 + 40 + 12 + 1) * KV;
const CARD_V = (1 + PREVIEW_H_V + 1 + (13 + 20 + 7 + 2 * 13 * 1.45 + 7 + 23 + 14) + 1) * KV;
const GRID_PAD_V = 14 * KV;
const GRID_GAP_V = 12 * KV;
const FOOTER_V = (10 + 36 + 14 + 1) * KV;

/** The sheet's scrollable grid area (world px). */
export function gridAreaV(): Box {
  const top = SURFACE_V.y + SHEET_V.top + KV + GRABBER_V + HEADER_V;
  const h = SHEET_V.height - 2 * KV - GRABBER_V - HEADER_V - FOOTER_V;
  return box(SURFACE_V.x + KV, top, SURFACE_V.w - 2 * KV, h);
}

/** Card i of the one-column sheet grid at scroll `scrollY` (world px). */
export function cardWorldV(i: number, scrollY: number) {
  const g = gridAreaV();
  const w = g.w - 2 * GRID_PAD_V;
  const x = g.x + GRID_PAD_V;
  const y = g.y + GRID_PAD_V + i * (CARD_V + GRID_GAP_V) - scrollY;
  return { card: box(x, y, w, CARD_V), preview: box(x + KV, y + KV, w - 2 * KV, PREVIEW_H_V * KV) };
}

/** Scroll that centres card i's preview in the grid area. */
export const scrollToCenterV = (i: number) => {
  const g = gridAreaV();
  return cardWorldV(i, 0).preview.cy - g.cy;
};

/** ui/Toast on phones (≤ 900px): top 64px (under the bar), right 16px — surface-local px. */
export const TOAST_V = { right: 16 * KV, top: 64 * KV, maxWidth: 360 };
