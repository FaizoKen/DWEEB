import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Background } from "../components/Background";
import { Camera, useFilmFrame, useVertical, type Shot } from "../components/Camera";
import { CAPTION_EXIT_FRAMES, type CaptionCue } from "../components/Caption";
import { requiredLegibleFrames } from "../components/CaptionTrack";
import { Cursor, PRESS_FRAMES, cursorAt, cursorOpacity, type Waypoint } from "../components/Cursor";
import { ATTACH_GOLD } from "../components/DiscordUI";
import {
  AddActionModal,
  AttachedPluginChip,
  Backdrop,
  BUTTON_EDITOR_H,
  ButtonInlineEditor,
  UiScale,
  type ActionCardState,
  type TreeEditorSlot,
} from "../components/editor";
import { SFX_FRAMES, VOL, sfxVariant } from "../audio";
import { campaignState } from "../story/campaign";
import { FPS, SCENES, TRANSITION_FRAMES, at, atAbs, seqFrom } from "../timeline";
import { EDITOR_GLOW, EDITOR_L, EDITOR_V, EDITOR_WIDE_L, PORTRAIT_CAM } from "./contracts";
import { NEW_BUTTON_GLOW_V, assistantRest, captions as assistantCaptions } from "./S05Assistant";
import {
  DOCK_FRAMES,
  LandscapeAct,
  PORTRAIT_BOTTOM,
  PORTRAIT_ORIGIN,
  PORTRAIT_SIZE,
  PREVIEW_V,
  TREE_V_PRE,
  PingRing,
  PortraitAct,
  Sfx,
  previewCardV,
  pulse,
  ramp,
  springAt,
  treeRowL,
  treeRowV,
  type ActFrameProps,
  type MessageBox,
} from "./plugins/act";

/**
 * VISUAL PLUGINS — "Then turn that button into a real giveaway. Visual plugins
 * power tickets, roles, forms, and more."
 *
 * Opens on the assistant's last frame (hold cut). The AI steps aside; the
 * product's own attach flow follows: select "Button · Enter giveaway" → its
 * inline editor unfolds with the ACTION panel ("Browse plugins · 25") →
 * "Add an action" opens (a dialog in landscape, a sheet on the phone) → the
 * pointer hovers Giveaway and clicks it right after the VO says "giveaway"
 * (✓ only after the click). The library stays open while Tickets, Self Role
 * and Modal Form catch the light on their words and the named row lights on
 * "and more"; then it closes, the attached chip springs into the inline panel
 * and the preview's button glows gold — the moment it becomes a working
 * giveaway. The landscape camera leans in on the library while it is up and is
 * back on the whole window before the attach, so cause (the chip) and effect
 * (the button) land in one frame.
 *
 * The scene ends with the row still selected and its chip in view: the VO
 * leaves 14 frames after "and more", too few to collapse the selection without
 * swallowing the payoff. The send scene opens on that exact frame.
 */

const T = TRANSITION_FRAMES;

/* ── Beats ──────────────────────────────────────────────────────────────── */

const W = {
  button: at("plugins", "button"),
  real: at("plugins", "real"),
  giveaway: at("plugins", "giveaway"),
  giveawayEnd: at("plugins", "giveaway", { edge: "end" }),
  tickets: at("plugins", "tickets"),
  roles: at("plugins", "roles"),
  forms: at("plugins", "forms"),
  and: at("plugins", "and"),
  more: at("plugins", "more"),
  moreEnd: at("plugins", "more", { edge: "end" }),
};

export const PLUG = (() => {
  const browse = W.real + 7;
  const attach = W.more + 6;
  const beats = {
    /** The AI steps aside on the first frame after the cut's hold. */
    aiOut: T + 2,
    /** Select the row on "button". */
    row: W.button - 1,
    /** Open the library on "real". */
    browse,
    /** Landscape: the camera leans in on the library as it opens, settled before the pick… */
    push: [browse + 3, browse + 23] as const,
    /** Hover the card while "giveaway" is spoken (once the library is up)… */
    hover: Math.max(W.giveaway - 2, browse + 16),
    /** …and click it right after. */
    pick: W.giveawayEnd + 1,
    /** Each card catches the light on its word. */
    glints: { tickets: W.tickets - 3, "self-role": W.roles - 3, "modal-form": W.forms - 3 },
    more: W.and - 2,
    /** …and is back on the whole window before the attach (the "and more" row lights on the way). */
    pull: [attach - 25, attach - 3] as const,
    /** Close once "more" has been said, attach in the pause after it. */
    close: W.more + 2,
    attach,
    /** The attach chime, in the pause after "more" (played by the film's SFX track). */
    chime: W.moreEnd,
  };
  if (
    !(
      beats.row > beats.aiOut + 14 &&
      beats.browse > beats.row + 22 &&
      beats.pick > beats.browse + 18 &&
      beats.push[1] < beats.pick &&
      beats.pull[0] > beats.glints["modal-form"] + 12 &&
      beats.more > beats.glints["modal-form"] + 12 &&
      beats.attach < SCENES.plugins.durationInFrames + T - 12
    )
  ) {
    throw new Error(`S06Plugins: the VO no longer fits the plugin beats (${JSON.stringify(beats)}) — re-key them.`);
  }
  return beats;
})();

const ATTACH_ABS = seqFrom("plugins") + PLUG.attach;
/**
 * The gold "now it works" glow on the preview button and the chip. It runs on
 * the FILM clock because it fades out across the plugins→send hold cut — both
 * scenes compute the same value at any film frame, so the cut stays invisible.
 */
export const attachGlow = (filmFrame: number) => pulse(filmFrame, ATTACH_ABS, ATTACH_ABS + 50, 6, 26);

/* ── Layout constants ───────────────────────────────────────────────────── */

/**
 * Landscape tree scroll while the row is open: the Container and Text rows
 * scroll out whole (Media gallery is the first row, 1 px under the bar), and
 * the unfolded editor plus every row below it fit above the pane's bottom —
 * nothing is cut at either edge.
 */
const SCROLL_L = 181;
/** Portrait tree scroll once the row is open: the row sits at the top with its ACTION panel below
 *  (the product scrolls a lower-half row up so its editor isn't below the fold). */
const SCROLL_V_OPEN = 309;

/** "Add an action" (landscape): the product's dialog, top-anchored and centred on the window. */
const MODAL_K = 1.25;
const MODAL_W = 700;
const MODAL_TOP = 70; // window-relative
const MODAL_LEFT = (EDITOR_L.width - MODAL_W) / 2;

/* ── Landscape camera ───────────────────────────────────────────────────── */

/** The dialog's box in the world; its height (content-sized, at MODAL_K) measured on a full-scale still. */
const MODAL_BOX_L = { x: EDITOR_L.x + 1 + MODAL_LEFT, y: EDITOR_L.y + 1 + MODAL_TOP, w: MODAL_W, h: 668.6 };
/** Canvas y of the landscape caption plate's top edge (measured: a 122 px plate, 96 px above the bottom). */
const CAPTION_TOP_L = 862;
/** Canvas px left above the dialog (to the frame edge) and below it (to the caption plate) in the push. */
const PUSH_MARGIN = { top: 24, bottom: 8 };
const PUSH_S = (CAPTION_TOP_L - PUSH_MARGIN.top - PUSH_MARGIN.bottom) / MODAL_BOX_L.h;
/**
 * While the library is up the camera frames the dialog WHOLE, centred on it,
 * in the band above the caption plate: at the whole-window framing its cards
 * read small, and it is the only thing to read. The push is capped by the
 * plate (VISUAL PLUGINS is up through the whole library): any tighter and the
 * plate would sit on the dialog's lowest rows — the "and more" row and LINK TO
 * A SERVICE, which light on "and more". The dimmed editor behind is cropped.
 */
const PUSH_L = {
  x: MODAL_BOX_L.x + MODAL_BOX_L.w / 2,
  // The camera centres world y on canvas y 540, so this puts the dialog's top PUSH_MARGIN.top below the frame edge.
  y: MODAL_BOX_L.y + (540 - PUSH_MARGIN.top) / PUSH_S,
  s: PUSH_S,
};
/**
 * In as the library opens, out before the attach: the chip (tree) and the gold
 * button (preview) land together in the whole window, which is also the send
 * scene's opening framing (the plugins → send hold cut). Both moves are ~20
 * frames; measured peak 11 canvas px/frame (13 at the dialog's corners).
 */
const SHOTS_L: Shot[] = [
  { f: T, ...EDITOR_WIDE_L },
  { f: PLUG.push[0], ...EDITOR_WIDE_L },
  { f: PLUG.push[1], ...PUSH_L },
  { f: PLUG.pull[0], ...PUSH_L },
  { f: PLUG.pull[1], ...EDITOR_WIDE_L },
];

/* ── Geometry for the pointer ───────────────────────────────────────────── */

/** The ButtonInlineEditor's "Browse plugins" card centre, measured into its InlineEditorFrame (k = 1):
 *  14 frame padding + 1 border, the 31 px ACTION header + 10 gap, then the 62 px card. The pointer aims
 *  at its chevron (1 + 14 + 14 + 9 in from the frame's right edge), so the "25" stays readable. */
const BROWSE_CY = 15 + 31 + 10 + 31;
const BROWSE_CHEVRON = 1 + 14 + 14 + 9;
/**
 * Once attached, the chip (66 px) stands where the Browse card, its gap and
 * the "Set the ID manually" line stood (86.5 px): the panel shortens by the
 * difference as the chip springs in, and the rows below glide up with it.
 */
const ATTACHED_SHRINK = 20.5;
const editorSlot = (node: React.ReactNode, open = 1, attached = 0): TreeEditorSlot => ({
  rowId: "giveaway",
  height: BUTTON_EDITOR_H - ATTACHED_SHRINK * attached,
  open,
  node,
});

const finalState = campaignState("final");
const rowL = treeRowL(finalState, "giveaway", { scroll: SCROLL_L });
const editorL = treeRowL(finalState, "editor:giveaway", { scroll: SCROLL_L, editor: editorSlot(null) });
const BROWSE_L = { x: editorL.right - BROWSE_CHEVRON * EDITOR_L.k, y: editorL.top + BROWSE_CY * EDITOR_L.k };
/** The modal's Giveaway card (grid row 1, column 1): header 64+1, body padding 20, search 38 + 16,
 *  the INTERACTIVE head 30 + 16 — then a 93.8 px card (k = 1). */
const CARD_L = {
  x: EDITOR_L.x + 1 + MODAL_LEFT + 1 + 20 * MODAL_K + (MODAL_W - 2 - 40 * MODAL_K - 8 * MODAL_K) / 2 - 16,
  y: EDITOR_L.y + 1 + MODAL_TOP + 2 + (64 + 20 + 38 + 16 + 30 + 16 + 93.8 / 2 + 6) * MODAL_K,
};

const rowV = treeRowV(finalState, "giveaway", { scroll: TREE_V_PRE });
const editorV = treeRowV(finalState, "editor:giveaway", { scroll: SCROLL_V_OPEN, editor: editorSlot(null) });
const BROWSE_V = { x: editorV.right - BROWSE_CHEVRON * EDITOR_V.k, y: editorV.top + BROWSE_CY * EDITOR_V.k };
/** The "Add an action" sheet at the editor's k: grabber 13, header 52+1, body padding 14, search 38 +
 *  16, head 30 + 16, then the first 60.8 px card. The sheet is bottom-anchored, 599.2 k-px tall. */
const SHEET_V_H = 599.2 * EDITOR_V.k;
const CARD_V = {
  x: PORTRAIT_ORIGIN.x + PORTRAIT_SIZE.w - 46,
  y: PORTRAIT_BOTTOM - SHEET_V_H + (13 + 53 + 14 + 38 + 16 + 30 + 16 + 60.8 / 2) * EDITOR_V.k,
};

/* ── State ──────────────────────────────────────────────────────────────── */

/** Portrait: the preview scrolls the button rows up above the builder sheet as the AI sheet leaves. */
const PREVIEW_SCROLL_V = [PLUG.aiOut + 2, 22] as const;
const previewScrollV = (frame: number) => PREVIEW_V * ramp(frame, PREVIEW_SCROLL_V[0], PREVIEW_SCROLL_V[1]);

/**
 * Portrait: the first sighting of the AI's new 🎉 Enter giveaway (see
 * S05Assistant NEW_BUTTON_GLOW_V) — it popped in under the AI sheet, so this
 * is where the viewer meets it, and it sits in the builder sheet's shadow.
 * Its periwinkle halo, held at `hidden` strength since the pop, swells over
 * the second half of the scroll as the button rises past the sheet's edge;
 * the moment it stands whole above the edge (on "that button") one ring
 * pings out from it; the halo settles once its row is selected.
 */
const NEW_BUTTON_BOX_V: MessageBox = { x: 73, y: 420.4, w: 157, h: 31.5, r: 8 }; // measured, from the message's top-left
const NEW_BUTTON_IN_VIEW = (() => {
  const edge = PORTRAIT_ORIGIN.y + 1 + EDITOR_V.sheetTop;
  const [from, dur] = PREVIEW_SCROLL_V;
  for (let f = from; f <= from + dur; f++) {
    if (previewCardV(previewScrollV(f)).y + NEW_BUTTON_BOX_V.y + NEW_BUTTON_BOX_V.h <= edge) return f;
  }
  throw new Error("S06Plugins: the portrait scroll no longer lifts the new button above the builder sheet.");
})();
const PING_FRAMES = 16;
const newButtonGlowV = (frame: number) => {
  const { hidden } = NEW_BUTTON_GLOW_V;
  const swell = ramp(frame, PREVIEW_SCROLL_V[0] + 6, 12, (t) => t * t * (3 - 2 * t));
  return (hidden + (1 - hidden) * swell) * (1 - ramp(frame, PLUG.row, 16, (t) => t));
};
if (!(NEW_BUTTON_IN_VIEW < PLUG.row && NEW_BUTTON_IN_VIEW + PING_FRAMES < PLUG.browse)) {
  throw new Error(`S06Plugins: the new button's ping (${NEW_BUTTON_IN_VIEW}) no longer lands before its row is selected (${PLUG.row}).`);
}

/** The library's cards at a frame: hover (the pointer's arrival; a touch-down on the phone), then the
 *  pick; the others glint on their words. */
function libraryCards(frame: number, vert: boolean): Partial<Record<"giveaway" | "tickets" | "self-role" | "modal-form", ActionCardState>> {
  const g = PLUG.glints;
  const glint = (at: number) => {
    const t = (frame - at) / 18;
    return t > 0 && t < 1 ? t : undefined;
  };
  return {
    giveaway: { hover: ramp(frame, vert ? PLUG.pick - 3 : PLUG.hover, 4, (t) => t), selected: frame >= PLUG.pick },
    tickets: { glint: glint(g.tickets) },
    "self-role": { glint: glint(g["self-role"]) },
    "modal-form": { glint: glint(g["modal-form"]) },
  };
}

function pluginsFrame(frame: number, vert: boolean, film: number): ActFrameProps {
  const b = PLUG;
  const rest = assistantRest(vert);
  const attached = frame >= b.attach;
  const state = campaignState(attached ? "attached" : "final");
  const selected = frame >= b.row;
  const open = selected ? ramp(frame, b.row + 1, 10) : 0;
  // The library opens with the product's curve; it leaves fast (a 4-frame
  // fade, so it never lingers as a ghost over the preview) and the scrim
  // clears just after it. The phone's sheet slides away instead.
  const libIn = ramp(frame, b.browse + 1, 9);
  const lib = frame < b.close ? libIn : 1 - ramp(frame, b.close, vert ? 7 : 4, (t) => t * t);
  const scrim = frame < b.close ? libIn : 1 - ramp(frame, b.close + (vert ? 0 : 1), 7);
  const gold = attachGlow(film);

  const chipIn = springAt(frame, b.attach, { damping: 13, mass: 0.6, stiffness: 170 });
  const chip = attached ? <AttachedPluginChip reveal={chipIn} glow={gold} /> : undefined;
  const editor = editorSlot(
    <ButtonInlineEditor
      browseHover={frame >= b.browse - (vert ? 2 : 4) && frame < b.close}
      browsePressed={frame >= b.browse && frame < b.browse + PRESS_FRAMES}
      attached={chip}
    />,
    open,
    attached ? Math.min(1, chipIn) : 0,
  );

  // The preview: the AI's green wash retracts as the assistant steps aside;
  // portrait scrolls the button rows into view above the builder sheet, the
  // new button's halo swelling as it arrives.
  const newGlow = vert ? newButtonGlowV(frame) : 0;
  const ping = (frame - NEW_BUTTON_IN_VIEW) / PING_FRAMES;
  return {
    ...rest,
    state,
    pills: {},
    tree: {
      selected: selected ? "giveaway" : null,
      editor: selected ? editor : null,
      hover: !selected && frame >= b.row - (vert ? 4 : 3) ? "giveaway" : null,
      scroll: vert
        ? // Settles (≤ 20 canvas px/frame) before the finger comes down on "Browse plugins".
          TREE_V_PRE + (SCROLL_V_OPEN - TREE_V_PRE) * ramp(frame, b.row + 1, 24, (t) => t * t * (3 - 2 * t))
        : SCROLL_L * ramp(frame, b.aiOut, 22, (t) => t * t * (3 - 2 * t)),
    },
    preview: {
      selected: selected ? "giveaway" : null,
      glow: { giveaway: Math.max(newGlow, gold) },
      glowColor: gold > 0 ? { giveaway: ATTACH_GOLD } : newGlow > 0 ? { giveaway: NEW_BUTTON_GLOW_V.color } : undefined,
      bodyHighlight: 1 - ramp(frame, b.aiOut, 10, (t) => t),
      scroll: vert ? previewScrollV(frame) : 0,
    },
    // Only while it runs: at both cuts the preview is the bare message.
    previewOverlay:
      vert && ping > 0 && ping < 1 ? <PingRing box={NEW_BUTTON_BOX_V} t={ping} color={NEW_BUTTON_GLOW_V.color} /> : undefined,
    ai: rest.ai ? { ...rest.ai, reveal: 1 - ramp(frame, b.aiOut, vert ? DOCK_FRAMES + 1 : DOCK_FRAMES) } : null,
    ...(vert
      ? {
          sheet: lib > 0.001 ? <AddActionModal layout="sheet" cards={libraryCards(frame, vert)} moreLit={ramp(frame, b.more, 6)} reveal={lib} /> : undefined,
          scrim,
        }
      : {
          overlay:
            scrim > 0.001 ? (
              <Backdrop reveal={scrim}>
                {lib > 0.001 && (
                  <div style={{ position: "absolute", left: MODAL_LEFT, top: MODAL_TOP, width: MODAL_W }}>
                    <UiScale k={MODAL_K}>
                      <AddActionModal cards={libraryCards(frame, vert)} moreLit={ramp(frame, b.more, 6)} reveal={lib} />
                    </UiScale>
                  </div>
                )}
              </Backdrop>
            ) : undefined,
        }),
  };
}

/* ── Pointer paths ──────────────────────────────────────────────────────── */

/** Landscape: in from the right of the tree, onto the row (right third, so its label stays readable),
 *  down to the Browse card's "25 ›", then up to the Giveaway card and away. */
const POINTER_L: Waypoint[] = [
  { f: PLUG.row - 16, x: rowL.right - 40, y: rowL.cy + 120 },
  { f: PLUG.row - 1, x: rowL.right - 110, y: rowL.cy },
  { f: PLUG.row, x: rowL.right - 110, y: rowL.cy, press: true },
  { f: PLUG.row + 8, x: rowL.right - 110, y: rowL.cy },
  { f: PLUG.browse - 4, x: BROWSE_L.x, y: BROWSE_L.y },
  { f: PLUG.browse, x: BROWSE_L.x, y: BROWSE_L.y, press: true },
  { f: PLUG.hover - 1, x: CARD_L.x, y: CARD_L.y },
  { f: PLUG.pick, x: CARD_L.x, y: CARD_L.y, press: true },
  { f: PLUG.pick + PRESS_FRAMES + 12, x: CARD_L.x + 60, y: CARD_L.y + 70 },
];
const POINTER_L_ON: [number, number][] = [[PLUG.row - 16, PLUG.pick + PRESS_FRAMES + 12]];

/** Portrait: three taps — the row, "Browse plugins", then Giveaway in the sheet. A finger comes down
 *  on each target (fades in on the spot, taps, lifts); it moves only while it is invisible. */
const TOUCH_V: Waypoint[] = [
  { f: PLUG.row - 6, x: rowV.right - 110, y: rowV.cy },
  { f: PLUG.row, x: rowV.right - 110, y: rowV.cy, press: true },
  { f: PLUG.browse - 6, x: BROWSE_V.x, y: BROWSE_V.y },
  { f: PLUG.browse, x: BROWSE_V.x, y: BROWSE_V.y, press: true },
  { f: PLUG.pick - 6, x: CARD_V.x, y: CARD_V.y },
  { f: PLUG.pick, x: CARD_V.x, y: CARD_V.y, press: true },
];
const TOUCH_V_ON: [number, number][] = [
  [PLUG.row - 6, PLUG.row + 8],
  [PLUG.browse - 6, PLUG.browse + 8],
  [PLUG.pick - 6, PLUG.pick + 10],
];

/* ── Captions ───────────────────────────────────────────────────────────── */

const PLUGINS_CAPTION_FROM = atAbs("plugins", "giveaway", { offset: -2 });
export const captions: CaptionCue[] = [
  {
    id: "plugins",
    label: "Visual plugins",
    parts: ["Buttons that", { text: "actually work.", hl: true }],
    from: PLUGINS_CAPTION_FROM,
    // Holds through the pick and the glints, and its exit fade ends as the
    // landscape camera starts back out: under the library's scrim and with
    // the camera still, so nothing moves or unfolds behind the fading plate
    // (the attach reflows the tree rows under the caption zone).
    to: seqFrom("plugins") + PLUG.pull[0],
    accent: ATTACH_GOLD,
  },
];
{
  // Read in full: the parts settle 17 frames in (rise 8 + settle 9), then the
  // reading time, before the exit fade.
  const legible = captions[0].to - CAPTION_EXIT_FRAMES - (PLUGINS_CAPTION_FROM + 17);
  if (legible < requiredLegibleFrames(4, FPS)) {
    throw new Error(`S06Plugins: the VISUAL PLUGINS caption is legible ${legible} f, under its reading time — re-key it.`);
  }
  // The assistant's super must be gone before this scene selects the row: the
  // unfolding editor pushes tree rows into the caption zone behind its fade.
  const unfold = seqFrom("plugins") + PLUG.row + 1;
  if (assistantCaptions.some((c) => c.to > unfold)) {
    throw new Error(`S06Plugins: the AI ASSISTANT caption is still fading when the row's editor unfolds (${unfold}).`);
  }
}

/* ── Scene ──────────────────────────────────────────────────────────────── */

export const ScenePlugins: React.FC = () => {
  const frame = useCurrentFrame();
  const film = useFilmFrame();
  const vert = useVertical();
  const props = pluginsFrame(frame, vert, film);
  return (
    <AbsoluteFill>
      <Background glow={EDITOR_GLOW} />
      <Camera shots={vert ? [{ f: T, ...PORTRAIT_CAM }] : SHOTS_L}>
        {vert ? <PortraitAct {...props} /> : <LandscapeAct {...props} />}
        {vert ? (
          <Cursor variant="touch" {...cursorAt(frame, TOUCH_V)} opacity={cursorOpacity(frame, TOUCH_V_ON)} />
        ) : (
          <Cursor {...cursorAt(frame, POINTER_L)} opacity={cursorOpacity(frame, POINTER_L_ON)} />
        )}
      </Camera>

      <Sfx from={PLUG.row} src={sfxVariant("click", 0)} frames={SFX_FRAMES.click} volume={VOL.click} />
      <Sfx from={PLUG.browse} src={sfxVariant("click", 1)} frames={SFX_FRAMES.click} volume={VOL.click} />
      <Sfx from={PLUG.browse + 1} src={sfxVariant("pop", 1)} frames={SFX_FRAMES.pop} volume={VOL.pop} />
      <Sfx from={PLUG.pick} src={sfxVariant("click", 2)} frames={SFX_FRAMES.click} volume={VOL.click * 1.1} />
      {/* The attach chime (PLUG.chime, after "and more") rings across the
          plugins → send cut, so it plays from the film's SFX track (sfxTrack.tsx). */}
    </AbsoluteFill>
  );
};

/** The scene's last visible frame (the send scene opens on it). */
export const PLUG_LAST = SCENES.plugins.durationInFrames + T - 1;

/**
 * The frame this scene leaves on screen — the send scene opens on it (the
 * plugins→send hold cut). The gold glow is taken at the caller's film frame,
 * so it keeps fading across the cut instead of freezing.
 */
export const pluginsHold = (vert: boolean, film: number): ActFrameProps => pluginsFrame(PLUG_LAST, vert, film);
