import type { CampaignStage } from "../story/campaign";

/**
 * Hold-cut contracts for the editor act.
 *
 * From the end of the reveal to the landing in Discord the film is ONE
 * continuous take: reveal → templates → build → assistant → plugins → send are
 * joined by invisible `hold` cuts. A hold cut is only invisible when both
 * scenes render the identical frame, and several scenes are written by
 * different hands — so the frames on both sides of each cut are pinned here,
 * in one place, instead of being mirrored by hand in two scene files.
 *
 * Every editor scene renders EditorWindow (landscape) / PortraitEditor
 * (vertical) with the sizing below, and at a contract boundary it renders the
 * boundary state exactly:
 *   - camera at the canonical framing for the aspect (static through the
 *     16-frame overlap: the incoming scene's first keyframe is at
 *     f: TRANSITION_FRAMES),
 *   - the message at `stage`, stat pills = campaignStats(campaignState(stage))
 *     with no ok-flash or tick in flight,
 *   - no selection, no inline editor, no overlay / dock / sheet / toast, no
 *     hover / pressed / glow / pop in flight, tree and preview scrolled to 0,
 *     adders shown (they are always visible in the product's tree),
 *   - portrait: the builder sheet resting at the boundary's `sheetTop`,
 *   - the toolbar channel chip and undo state as listed,
 *   - no cursor (fade it out before the cut, in after it),
 *   - Background glow EDITOR_GLOW (the background runs on the film clock).
 * `npm run qa:cuts` checks the result.
 */

/** Landscape EditorWindow sizing shared by every editor scene. The window is
 *  placed at world (x, y) so the 1680×900 window is centred in the world. */
export const EDITOR_L = {
  width: 1680,
  height: 900,
  leftWidth: 600,
  k: 1.1,
  dk: 1.12,
  x: 120,
  y: 90,
  /**
   * The preview's message column (CampaignPreview maxWidth). The hook's card,
   * every editor scene and the Discord landing slot all use it: a scene that
   * passed another width would jump the card at a cut.
   */
  previewMaxW: 700,
} as const;

/**
 * Portrait editor sizing shared by every editor scene (defaults of
 * PortraitEditor). `sheetTop` is the builder sheet's resting detent from the
 * template pick through the send (cut B's), in surface units: it falls in the
 * gap between the gallery and the first button row of every stock-bodied
 * state, and — with the preview scrolled PREVIEW_V (plugins/act.tsx) — in the
 * gap between the finished message's second button row and its select. Cut A
 * rests higher (see EditorBoundary.sheetTop).
 */
export const EDITOR_V = { k: 1.07, barK: 1.04, dk: 1, sheetTop: 470 } as const;

/** Landscape whole-window framing: the 1680×900 window fits with ~33 world px
 *  of margin (visible world x 87–1833, y 49–1031). */
export const EDITOR_WIDE_L = { x: 960, y: 540, s: 1.1 } as const;

/** The vertical master films the 540×960 portrait stage with a locked camera. */
export const PORTRAIT_CAM = { x: 960, y: 540, s: 2 } as const;

/** Every scene from the reveal through send uses this Background glow. */
export const EDITOR_GLOW = "dual" as const;

export type EditorBoundary = {
  /** Message state on both sides of the cut. */
  stage: CampaignStage;
  /** Toolbar destination chip: null = the empty "Pick a channel" state. */
  channel: null | "announcements";
  canUndo: boolean;
  canRedo: boolean;
  /**
   * Portrait: where the builder sheet's top edge rests (surface units), with
   * the preview at scroll 0. The edge must fall in a GAP of the card above
   * it, never through a component — and one value cannot do that for every
   * state, because the finished message's two-line body puts its gaps 22
   * units higher than the stock-bodied states' three lines. Measured on
   * full-scale stills (surface units, preview scroll 0):
   *   final  — body ends 194.5 · gallery 204–440 · button row 1 448–480 · row 2 488–520 · select 528–568
   *   stock, retitled, reward, select — gallery ends 461.5 · button row 1 from 470
   * A per-boundary preview scroll cannot bridge those 22 units: the card's
   * author row sits only 14 units under the bar, so scrolling it would slice
   * the avatar — and the vertical reveal must hold the hook's card exactly
   * where it matched. So the sheet's detent is per boundary instead, and the
   * templates scene moves it while its directory sheet covers the editor.
   */
  sheetTop: number;
};

/** Cut A — reveal → templates: the freshly assembled editor holding the
 *  finished Season 4 message (the same card the hook promised). Portrait: the
 *  sheet rises to the gap between the card's two button rows (480–488), so
 *  the hook's card keeps its rect and its first row of buttons stays in view. */
export const CUT_A: EditorBoundary = {
  stage: "final",
  channel: null,
  canUndo: false,
  canRedo: false,
  sheetTop: 484,
};

/** Cut B — build → assistant: the personalised message (retitled, reward
 *  button and platform select added) just before the AI edit. Portrait: the
 *  sheet rests on the stock-bodied gap (EDITOR_V.sheetTop), as it has since
 *  the template pick. */
export const CUT_B: EditorBoundary = {
  stage: "select",
  channel: null,
  canUndo: true,
  canRedo: false,
  sheetTop: EDITOR_V.sheetTop,
};
