import React from "react";
import { AbsoluteFill, Audio, Easing, Sequence, staticFile, useCurrentFrame } from "remotion";
import { Background } from "../components/Background";
import { Camera, type Shot, useVertical } from "../components/Camera";
import type { CaptionCue } from "../components/Caption";
import { Cursor, cursorAt, cursorOpacity, type Waypoint } from "../components/Cursor";
import { MessageDirectory, TemplatePickToast, editorWindowGeometry, portraitEditorGeometry } from "../components/editor";
import { SFX_FRAMES, VOL, sfxVariant } from "../audio";
import { TRANSITION_FRAMES, at, atAbs } from "../timeline";
import { COLORS } from "../theme";
import { campaignState } from "../story/campaign";
import { CUT_A, EDITOR_GLOW, EDITOR_L, EDITOR_V, EDITOR_WIDE_L, PORTRAIT_CAM } from "./contracts";
import { LandscapeAct, PortraitAct } from "./plugins/act";
import { EASE_RISE, EASE_UI, envelope, ramp, stockArt } from "./build/kit";
import { SurfaceOverlayV } from "./build/SurfaceOverlay";
import { TB, TB_PARK_L } from "./build/boundary";
import {
  PAGE_L,
  PANEL_L,
  PREVIEW_H_V,
  SHEET_V,
  TOAST_L,
  TOAST_V,
  cardWorldL,
  cardWorldV,
  gridAreaV,
  panelWorldL,
  scrollToCenterV,
} from "./templates/geometry";

/*
 * TEMPLATES — the first beat of the editor act's one continuous take.
 *
 * It opens on cut A (the reveal's settled editor, holding the finished Season
 * 4 message). The pointer clicks the action bar's Message directory icon as
 * the VO says "Start with…"; the real directory overlay opens over the editor
 * (a bottom sheet on the portrait stage); the pointer browses Welcome and
 * Patch notes (a swipe through the list on a phone) and uses the Announcement
 * template on "template". The product then does exactly what it does: the
 * overlay closes, the editor underneath now holds the STOCK Announcement,
 * Undo lights up, and the pick toast says "make it yours, then Send" as the
 * VO says "then make every detail yours". It ends — toast gone, framing wide —
 * on the build scene's first frame (the templates → build hold cut).
 */

const T = TRANSITION_FRAMES;

/* ── Beats (scene-local frames, keyed to the VO) ────────────────────────── */

/** Click the Message directory icon just ahead of "Start with…". */
const DIR_PRESS = at("templates", "Start", { offset: -3 });
/** The directory opens on the click's release. */
const OPEN = DIR_PRESS + 1;
/** "Use this template →" on Announcement, landing on the tail of "template". */
const USE_PRESS = at("templates", "template", { edge: "end", offset: -1 });
/** The product applies the template and closes the directory on the click. */
const PICK = USE_PRESS + 1;
/** The pick toast rises as the overlay clears. */
const TOAST_IN = PICK + 3;
/**
 * The toast leaves before the cut so the build opens on a clean editor. On the
 * portrait stage it sits where the product puts it on phones — under the bar,
 * right over the new "📢 Announcement" heading, the proof of what the pick
 * loaded — so it stays only long enough to be seen (~0.8 s whole), and the
 * stock heading reads clear for the ~2 s before the build selects it.
 */
const TOAST_OUT_L = PICK + 55;
const TOAST_OUT_V = PICK + 30;
/** The landscape pointer is home (TB_PARK_L) and still from here to the cut. */
const PARK_AT = PICK + 32;
/** Portrait: frames the directory sheet takes to rise over the editor. */
const SHEET_RISE_V = 11;
/**
 * Portrait: the builder sheet opens on cut A's detent (between the finished
 * card's two button rows) and must rest on the stock template's (between its
 * gallery and first button row) when the directory uncovers the editor — so
 * it moves while the directory sheet, fully up, covers everything under the
 * bar: never on screen (contracts.ts EditorBoundary.sheetTop).
 */
const DETENT_AT = OPEN + SHEET_RISE_V;
if (DETENT_AT >= PICK) {
  throw new Error(`S03Templates: the directory is up at ${DETENT_AT}, after the pick (${PICK}) — the sheet's detent change would show.`);
}

/* ── Captions ────────────────────────────────────────────────────────────── */

/** TEMPLATES — "Start polished." then "Make it yours." rising on "make". */
export const captions: CaptionCue[] = [
  {
    id: "templates",
    label: "Templates",
    parts: ["Start polished.", { text: "Make it yours.", hl: true, at: atAbs("templates", "make", { offset: -2 }) }],
    from: atAbs("templates", "template", { offset: -3 }),
    // Holds across the templates → build cut until the build super takes over.
    to: atAbs("build", "real", { offset: -7 }),
    accent: COLORS.green,
  },
];

/* ── Shared state ────────────────────────────────────────────────────────── */

/** Message + toolbar state: cut A's finished message until the pick, the stock template after. */
function editorState(frame: number) {
  const picked = frame >= PICK;
  return {
    state: campaignState(picked ? TB.stage : CUT_A.stage),
    canUndo: picked ? TB.canUndo : CUT_A.canUndo,
    gallerySwap: picked ? stockArt(1) : undefined,
  };
}

/** Directory card hover (0..1) for a pointer dwell [arrive, leave): the product's 140 ms transitions. */
const hoverOf = (frame: number, arrive: number, leave: number) =>
  Math.min(ramp(frame, arrive - 2, 4, EASE_UI), 1 - ramp(frame, leave, 4, EASE_UI));

const Sfx: React.FC<{ at: number; src: string; volume: number; frames: number }> = ({ at: from, src, volume, frames }) => (
  <Sequence from={from} durationInFrames={frames}>
    <Audio src={staticFile(src)} volume={volume} />
  </Sequence>
);

/** The scene's sounds, identical in both aspects (the beats are shared). */
const TemplatesSfx: React.FC = () => (
  <>
    <Sfx at={DIR_PRESS} src={sfxVariant("click", 0)} volume={VOL.click} frames={SFX_FRAMES.click} />
    <Sfx at={USE_PRESS} src={sfxVariant("click", 1)} volume={VOL.click} frames={SFX_FRAMES.click} />
    {/* The template landing in the editor: a soft confirmation under "then make…". */}
    <Sfx at={TOAST_IN} src={sfxVariant("pop", 0)} volume={VOL.pop * 0.85} frames={SFX_FRAMES.pop} />
  </>
);

export const SceneTemplates: React.FC = () => {
  const vertical = useVertical();
  return (
    <AbsoluteFill>
      <Background glow={EDITOR_GLOW} />
      {vertical ? <TemplatesPortrait /> : <TemplatesLandscape />}
      <TemplatesSfx />
    </AbsoluteFill>
  );
};

/* ── Landscape ───────────────────────────────────────────────────────────── */

// The cards the pointer visits, by grid cell (DEFAULT_DIRECTORY_CARDS order: Patch notes sits under Announcement).
const WELCOME_L = cardWorldL(0, 1);
const ANNOUNCE_L = cardWorldL(0, 2);
const PATCH_L = cardWorldL(1, 2);

const DIR_ICON_L = (() => {
  const g = editorWindowGeometry({ leftWidth: EDITOR_L.leftWidth, k: EDITOR_L.k, bar: { channel: CUT_A.channel }, meta: {} });
  return { x: EDITOR_L.x + g.bar.directory!.x, y: EDITOR_L.y + g.bar.directory!.y };
})();

/**
 * Hover aims sit in a preview's right edge, clear of the centred "Use this
 * template →" chip: low on Welcome, high on Patch notes (only the top of its
 * row shows above the footer) — which also keeps the three hops short.
 */
const aimOf = (preview: { x: number; y: number; w: number; h: number }, down: number) => ({
  x: preview.x + preview.w * 0.84,
  y: preview.y + preview.h * down,
});

/** Dwell on each card long enough to read its hover; hops of 9–12 frames between. */
const L_BEATS = {
  welcome: { arrive: DIR_PRESS + 17, leave: DIR_PRESS + 23 },
  patch: { arrive: DIR_PRESS + 33, leave: DIR_PRESS + 37 },
};

const WAYPOINTS_L: Waypoint[] = (() => {
  const welcome = aimOf(WELCOME_L.preview, 0.78);
  const patch = aimOf(PATCH_L.preview, 0.25);
  // "Use this template →" is centred in the preview: aim at its right third.
  const use = { x: ANNOUNCE_L.preview.cx + 52, y: ANNOUNCE_L.preview.cy + 2 };
  return [
    { f: T + 2, x: DIR_ICON_L.x + 150, y: DIR_ICON_L.y + 120 },
    { f: DIR_PRESS - 1, ...DIR_ICON_L },
    { f: DIR_PRESS, ...DIR_ICON_L, press: true },
    { f: DIR_PRESS + 5, ...DIR_ICON_L },
    { f: L_BEATS.welcome.arrive, ...welcome },
    { f: L_BEATS.welcome.leave, ...welcome },
    { f: L_BEATS.patch.arrive, ...patch },
    { f: L_BEATS.patch.leave, ...patch },
    { f: USE_PRESS - 1, ...use },
    { f: USE_PRESS, ...use, press: true },
    { f: USE_PRESS + 6, ...use },
    // Drift home to rest beside the tree, where the build scene picks it up.
    { f: PARK_AT, ...TB_PARK_L },
  ];
})();

/**
 * Wide on cut A, a gentle push onto the whole directory panel (the editor
 * behind it is dimmed and blurred by the backdrop), then back to wide for the
 * build. The way back starts fast as the panel vanishes — so the editor's
 * edges, and the toast landing top-right, are inside the frame within a few
 * frames — and settles long.
 *
 * The push frames the panel whole and the browser chrome not at all: at s 1.2
 * the frame is 900 world px tall, and centred at y 590 its top edge (world 140)
 * falls just under the chrome (world 91–136) while the panel (world ~162–963)
 * keeps a margin at both edges. Centred on the panel instead (y 560), the top
 * edge cut the traffic lights and the URL in half for the whole hold.
 */
const PUSH_L = { x: 960, y: 590, s: 1.2 } as const;
const PULL_BACK_EASE = Easing.bezier(0.2, 0.7, 0.3, 1);
const SHOTS_L: Shot[] = [
  { f: T, ...EDITOR_WIDE_L },
  { f: OPEN + 1, ...EDITOR_WIDE_L },
  { f: OPEN + 26, ...PUSH_L },
  { f: PICK, ...PUSH_L },
  { f: PICK + 30, ...EDITOR_WIDE_L, ease: PULL_BACK_EASE },
];
{
  // The push's frame (world px) must hold the whole panel and none of the chrome.
  const [left, right] = [PUSH_L.x - 960 / PUSH_L.s, PUSH_L.x + 960 / PUSH_L.s];
  const [top, bottom] = [PUSH_L.y - 540 / PUSH_L.s, PUSH_L.y + 540 / PUSH_L.s];
  const panel = panelWorldL();
  const chromeBottom = EDITOR_L.y + 1 + PAGE_L.top;
  if (top < chromeBottom || panel.y < top || panel.y + panel.h > bottom || panel.x < left || panel.x + panel.w > right) {
    throw new Error(
      `S03Templates: the directory push (world ${left.toFixed(0)}–${right.toFixed(0)} × ${top.toFixed(1)}–${bottom.toFixed(1)}) ` +
        `must exclude the browser chrome (to y ${chromeBottom}) and hold the whole panel ` +
        `(${panel.x.toFixed(0)}–${(panel.x + panel.w).toFixed(0)} × ${panel.y.toFixed(1)}–${(panel.y + panel.h).toFixed(1)}).`,
    );
  }
}

const TemplatesLandscape: React.FC = () => {
  const frame = useCurrentFrame();
  const { state, canUndo, gallerySwap } = editorState(frame);

  const open = frame < PICK ? ramp(frame, OPEN, 7, EASE_RISE) : 1;
  // The product unmounts the directory on the pick; a 3-frame fade keeps that
  // crisp without a hard pop, and the backdrop clears just behind it.
  const closing = ramp(frame, PICK, 3, EASE_UI);
  const backdrop = ramp(frame, OPEN, 5, EASE_UI) * (1 - ramp(frame, PICK, 6, EASE_UI));
  const toast = ramp(frame, TOAST_IN, 7, EASE_RISE) * (1 - ramp(frame, TOAST_OUT_L, 8, EASE_UI));

  const welcome = hoverOf(frame, L_BEATS.welcome.arrive, L_BEATS.welcome.leave);
  const patch = hoverOf(frame, L_BEATS.patch.arrive, L_BEATS.patch.leave);
  const announce = hoverOf(frame, USE_PRESS - 1, PICK + 8);

  const barHover = frame >= DIR_PRESS - 2 && frame < OPEN + 2 ? ("directory" as const) : null;
  const barPressed = frame >= DIR_PRESS && frame < DIR_PRESS + 4 ? ("directory" as const) : null;

  const overlay =
    backdrop > 0.001 || toast > 0.001 ? (
      <>
        {backdrop > 0.001 && (
          <div
            style={{
              position: "absolute",
              left: 0,
              top: PAGE_L.top,
              width: PAGE_L.width,
              height: PAGE_L.height,
              // .backdrop: rgba(6, 7, 10, 0.66) + blur(6px), fading in over 160 ms.
              background: `rgba(6,7,10,${(0.66 * backdrop).toFixed(3)})`,
              backdropFilter: `blur(${(6 * EDITOR_L.k * backdrop).toFixed(2)}px)`,
            }}
          />
        )}
        {open > 0.001 && closing < 0.999 && (
          <div
            style={{
              position: "absolute",
              left: PANEL_L.left,
              top: PANEL_L.top,
              width: PANEL_L.w,
              height: PANEL_L.h,
              opacity: closing > 0 ? 1 - closing : undefined,
              transform: closing > 0 ? `scale(${1 - 0.012 * closing})` : undefined,
            }}
          >
            <MessageDirectory
              layout="overlay"
              reveal={open}
              states={{
                welcome: { hover: welcome },
                "patch-notes": { hover: patch },
                announcement: { hover: announce, pressed: frame >= USE_PRESS && frame < USE_PRESS + 4 },
              }}
            />
          </div>
        )}
        {toast > 0.001 && (
          <div style={{ position: "absolute", right: TOAST_L.right, top: TOAST_L.top }}>
            <TemplatePickToast reveal={toast} maxWidth={TOAST_L.maxWidth} />
          </div>
        )}
      </>
    ) : undefined;

  return (
    <Camera shots={SHOTS_L}>
      <LandscapeAct
        state={state}
        bar={{ channel: CUT_A.channel, canUndo, canRedo: CUT_A.canRedo, hover: barHover, pressed: barPressed }}
        preview={{ gallerySwap }}
        overlay={overlay}
      />
      <Cursor {...cursorAt(frame, WAYPOINTS_L)} opacity={cursorOpacity(frame, [[T + 2, Infinity]])} />
    </Camera>
  );
};

/* ── Portrait ────────────────────────────────────────────────────────────── */

/** The one-column sheet shows these three; Announcement is the second card. */
const CARDS_V = ["welcome", "announcement", "patch-notes"];

const DIR_ICON_V = (() => {
  const g = portraitEditorGeometry({ ...EDITOR_V, bar: { channel: CUT_A.channel } });
  return g.bar.directory!;
})();

/**
 * The swipe settles with Announcement whole in the upper part of the list and
 * the next template (Patch notes) peeking under it — so the gesture reads as
 * browsing a longer list, not jumping to a known card.
 */
const SCROLL_END_V = (() => {
  const g = gridAreaV();
  const announce = cardWorldV(1, 0).card;
  const next = cardWorldV(2, 0).card;
  // Announcement's top 14px under the list's top edge at most; the next card's first ~110px showing.
  const peek = next.y + 110 * EDITOR_V.k - (g.y + g.h);
  return Math.round(Math.min(announce.y - g.y - 14, Math.max(peek, scrollToCenterV(1))));
})();

const V_BEATS = {
  /** Finger down on the list, dragging it up, then released into a short fling. */
  swipeDown: DIR_PRESS + 15,
  swipeUp: DIR_PRESS + 25,
  flingEnd: DIR_PRESS + 34,
};

/** Portion of the scroll the finger drags; the fling carries the rest. */
const DRAG_SHARE = 0.72;

function sheetScrollV(frame: number) {
  const drag = ramp(frame, V_BEATS.swipeDown, V_BEATS.swipeUp - V_BEATS.swipeDown, (t) => t);
  const fling = ramp(frame, V_BEATS.swipeUp, V_BEATS.flingEnd - V_BEATS.swipeUp, EASE_RISE);
  return SCROLL_END_V * (DRAG_SHARE * drag + (1 - DRAG_SHARE) * fling);
}

/**
 * The touch indicator. A finger only exists while it is down, so it lands for
 * each gesture and lifts after it: the tap on the bar icon, the swipe through
 * the list (the list follows it 1:1), the tap on Announcement.
 */
function touchV(frame: number) {
  const g = gridAreaV();
  const dragFrom = { x: g.cx + 40, y: g.y + g.h * 0.8 };
  const announce = cardWorldV(1, SCROLL_END_V).preview;
  const fade = { fadeIn: 4, fadeOut: 4 };
  const tap = (at: number, p: { x: number; y: number }) => ({
    pose: { ...p, pressed: false, pressAge: frame >= at && frame < at + 10 ? frame - at : null },
    opacity: cursorOpacity(frame, [[at - 5, at + 5]], fade),
  });
  if (frame < V_BEATS.swipeDown - 6) return tap(DIR_PRESS, DIR_ICON_V);
  if (frame >= USE_PRESS - 6) return tap(USE_PRESS, { x: announce.x + announce.w * 0.8, y: announce.cy + 26 });
  const t = ramp(frame, V_BEATS.swipeDown, V_BEATS.swipeUp - V_BEATS.swipeDown, (x) => x);
  return {
    pose: {
      x: dragFrom.x,
      y: dragFrom.y - SCROLL_END_V * DRAG_SHARE * t,
      pressed: frame >= V_BEATS.swipeDown && frame < V_BEATS.swipeUp,
      pressAge: null,
    },
    opacity: cursorOpacity(frame, [[V_BEATS.swipeDown - 4, V_BEATS.swipeUp + 4]], fade),
  };
}

const TemplatesPortrait: React.FC = () => {
  const frame = useCurrentFrame();
  const { state, canUndo, gallerySwap } = editorState(frame);

  // The sheet slides up on the tap and back down on the pick.
  const rise = frame < PICK ? ramp(frame, OPEN, SHEET_RISE_V, EASE_RISE) : 1 - ramp(frame, PICK, 10, EASE_UI);
  const scrim = frame < PICK ? ramp(frame, OPEN, 7, EASE_UI) : 1 - ramp(frame, PICK, 8, EASE_UI);
  const toast = ramp(frame, TOAST_IN, 7, EASE_RISE) * (1 - ramp(frame, TOAST_OUT_V, 8, EASE_UI));
  // A tap is a hover + press on touch: the "Use this template →" chip flashes under the finger.
  const announce = envelope(frame, USE_PRESS - 3, PICK + 10, 3, 6);

  const touch = touchV(frame);
  const barPressed = frame >= DIR_PRESS && frame < DIR_PRESS + 4 ? ("directory" as const) : null;

  return (
    <Camera shots={[{ f: T, ...PORTRAIT_CAM }]}>
      <PortraitAct
        state={state}
        bar={{ channel: CUT_A.channel, canUndo, canRedo: CUT_A.canRedo, pressed: barPressed }}
        preview={{ gallerySwap }}
        sheetTop={frame < DETENT_AT ? CUT_A.sheetTop : TB.sheetTop}
        scrim={scrim}
        sheet={
          rise > 0.001 ? (
            <MessageDirectory
              layout="sheet"
              columns={1}
              cards={CARDS_V}
              previewH={PREVIEW_H_V}
              height={SHEET_V.height}
              reveal={rise}
              scrollY={sheetScrollV(frame)}
              states={{ announcement: { hover: announce, pressed: frame >= USE_PRESS && frame < USE_PRESS + 4 } }}
            />
          ) : undefined
        }
      />
      {toast > 0.001 && (
        <SurfaceOverlayV>
          <div style={{ position: "absolute", right: TOAST_V.right, top: TOAST_V.top }}>
            <TemplatePickToast reveal={toast} maxWidth={TOAST_V.maxWidth} />
          </div>
        </SurfaceOverlayV>
      )}
      <Cursor variant="touch" {...touch.pose} opacity={touch.opacity} />
    </Camera>
  );
};

