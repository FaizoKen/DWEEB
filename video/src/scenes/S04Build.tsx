import React from "react";
import { AbsoluteFill, Audio, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Background } from "../components/Background";
import { Camera, DEFAULT_EASE, useVertical } from "../components/Camera";
import type { CaptionCue } from "../components/Caption";
import { Cursor, cursorAt, cursorOpacity, type Waypoint } from "../components/Cursor";
import { settle } from "../components/Bits";
import {
  AddComponentMenu,
  GALLERY_EDITOR_H,
  GalleryInlineEditor,
  TEXT_EDITOR_H,
  TextInlineEditor,
  type AddMenuItem,
  type TreeEditorSlot,
} from "../components/editor";
import { SFX_FRAMES, VOL, sfxVariant } from "../audio";
import { TRANSITION_FRAMES, atAbs } from "../timeline";
import { COLORS } from "../theme";
import {
  HEADING,
  RETITLE_KEYS,
  campaignState,
  campaignStats,
  retitleHeading,
  textContent,
  type CampaignStage,
  type CampaignState,
} from "../story/campaign";
import { graphemes } from "../story/rules";
import { CUT_B, EDITOR_GLOW, EDITOR_L, EDITOR_V, EDITOR_WIDE_L, PORTRAIT_CAM } from "./contracts";
import { LandscapeAct, PortraitAct } from "./plugins/act";
import { TB, TB_PARK_L } from "./build/boundary";
import { EASE_RISE, EASE_UI, bump, envelope, mix, ramp, stockArt } from "./build/kit";
import {
  BEATS_L,
  BEATS_V,
  KEY_FRAMES,
  OK_OFF,
  OK_ON,
  SEL_DOWN,
  SEL_UP,
  TYPE_END,
  TYPE_START,
  keysTyped,
  type BuildBeats,
} from "./build/beats";
import {
  addMenuRows,
  adderWidth,
  dropZone,
  headingLinePoint,
  pillsSurfaceV,
  pillsWindowL,
  treeBox,
  type Box,
} from "./build/geometry";
import { SURFACE_V } from "./templates/geometry";
import { SurfaceOverlayV } from "./build/SurfaceOverlay";
import { PillsHalo } from "./build/PillsHalo";

/*
 * BUILD — stock → personalised, in the same continuous take.
 *
 * Opens on the templates → build hold cut (the stock Announcement). The Text
 * row's inline editor unfolds; "📢 Announcement" is drag-selected and
 * "🚀 Season 4 is live" typed over it, key by key, while the tree summary, the
 * character pill and the preview heading follow every keystroke. The Media
 * gallery row opens; a new image lands in its drop zone and the preview's hero
 * crossfades to the Season 4 art. "+ Add button" adds 🎁 Claim reward (tree row
 * and preview button in the same frame); "+ Add to container" flashes the real
 * add menu (Interactive ▸ Buttons & menus ▸ Options menu) and the platform
 * select pops in. The stat pills tick with each change and flash green ✓ on
 * "checked", ringed by a halo that pings once (their text alone is too small
 * to carry the line in the landscape wide). Everything settles onto cut B for
 * the assistant scene.
 */

const T = TRANSITION_FRAMES;

// The toolbar and the portrait sheet's detent never change in this scene, so
// the state it opens on (the templates → build cut) must already be cut B's.
if (
  TB.channel !== CUT_B.channel ||
  TB.canUndo !== CUT_B.canUndo ||
  TB.canRedo !== CUT_B.canRedo ||
  TB.sheetTop !== CUT_B.sheetTop
) {
  throw new Error("S04Build: the templates → build toolbar / sheet state (build/boundary.ts TB) must equal cut B's.");
}

/* ── Captions ────────────────────────────────────────────────────────────── */

/**
 * LIVE PREVIEW — "Real components." with "real", then "Every limit checked."
 * rising onto "checked". It holds past the build → assistant cut so the
 * second half gets its full reading time (the caption track spans cuts).
 */
export const captions: CaptionCue[] = [
  {
    id: "build",
    label: "Live preview",
    parts: [
      { text: "Real components.", at: atAbs("build", "real", { offset: -2 }) },
      { text: "Every limit checked.", hl: true, at: atAbs("build", "checked", { offset: -3 }) },
    ],
    from: atAbs("build", "real", { offset: -6 }),
    to: atAbs("build", "checked", { offset: -3 }) + 9 + 61 + 12,
    accent: COLORS.blurple,
  },
];

/* ── Per-frame story state ──────────────────────────────────────────────── */

const KL = EDITOR_L.k;
const KV = EDITOR_V.k;

/** Where the heading selection sits in the textarea: "# " then "📢 Announcement". */
const SEL_START = 2;
const STOCK_UNITS = graphemes(HEADING.stock).reduce<number[]>((acc, g) => [...acc, (acc[acc.length - 1] ?? 0) + g.length], []);

function stageAt(frame: number, B: BuildBeats): CampaignStage {
  if (frame > B.optionPress) return "select";
  if (frame > B.addButtonPress) return "reward";
  return keysTyped(frame) >= RETITLE_KEYS.length ? "retitled" : "stock";
}

function stateAt(frame: number, B: BuildBeats): CampaignState {
  const stage = stageAt(frame, B);
  return stage === "stock" ? campaignState("stock", { heading: retitleHeading(keysTyped(frame)) }) : campaignState(stage);
}

/** Which row is selected (the inline editor shows under it, the preview rings it). */
function selectionAt(frame: number, B: BuildBeats): "text" | "gallery" | null {
  const textEnd = B.textClose ?? B.galleryPress;
  const galleryEnd = B.addButtonPress;
  if (frame >= B.textPress && frame < textEnd) return "text";
  if (frame >= B.galleryPress && frame < galleryEnd) return "gallery";
  return null;
}

/** Unfold progress of the two inline editors. One tree slot: the gallery opens once the text editor has folded. */
function editorOpen(frame: number, B: BuildBeats) {
  const textClose = B.textClose ?? B.galleryPress;
  const text = ramp(frame, B.textPress + 1, 8) * (1 - ramp(frame, textClose + 1, 6));
  const galleryStart = B.textClose === null ? B.galleryPress + 7 : B.galleryPress + 1;
  const gallery = ramp(frame, galleryStart, 7) * (1 - ramp(frame, B.addButtonPress + 1, 7));
  return { text, gallery };
}

/** How far the drag across the heading has travelled (0..1) — the pointer and the selection share it. */
const dragT = (frame: number) => EASE_UI(Math.max(0, Math.min(1, (frame - SEL_DOWN) / (SEL_UP - SEL_DOWN))));

/** Selection while "📢 Announcement" is drag-selected: it follows the pointer, whole graphemes only. */
function selectionAtFrame(frame: number): [number, number] | undefined {
  if (frame <= SEL_DOWN || frame >= TYPE_START) return undefined;
  const n = Math.round(dragT(frame) * STOCK_UNITS.length);
  return n > 0 ? [SEL_START, SEL_START + STOCK_UNITS[n - 1]] : undefined;
}

/** Caret: solid while keys are arriving, a 16-frame blink when idle. */
const caretOn = (frame: number) =>
  (frame >= TYPE_START && frame <= TYPE_END + 2) || Math.floor((frame - TYPE_END) / 16) % 2 === 0;

function editorSlot(frame: number, state: CampaignState, B: BuildBeats): TreeEditorSlot | null {
  const open = editorOpen(frame, B);
  if (open.text > 0.001) {
    const typed = keysTyped(frame);
    return {
      rowId: "text",
      height: TEXT_EDITOR_H,
      open: open.text,
      node: (
        <TextInlineEditor
          content={textContent(state)}
          selection={selectionAtFrame(frame)}
          caret={typed > 0 ? SEL_START + state.heading.length : null}
          caretOn={caretOn(frame)}
          focused={frame >= SEL_DOWN}
        />
      ),
    };
  }
  if (open.gallery > 0.001) {
    return {
      rowId: "gallery",
      height: GALLERY_EDITOR_H,
      open: open.gallery,
      node: <GalleryInlineEditor dropActive={envelope(frame, B.dropPress - 1, B.dropPress + 16, 2, 9)} />,
    };
  }
  return null;
}

/** The drop zone's click point: its lower-right corner, clear of the two centred text lines. */
const dropAim = (zone: Box, k: number) => ({ x: zone.x + zone.w - 34 * k, y: zone.y + zone.h - 9 * k });

/** The hero art: the template's own until the new image lands, then the Season 4 art. */
const heroSwap = (frame: number, B: BuildBeats) => stockArt(1 - ramp(frame, B.dropPress + 3, 12));

/* ── The add menu ────────────────────────────────────────────────────────── */

/**
 * The add menu opens off "+ Add to container". The adder sits low in the pane,
 * so — exactly like the product's placement code — it flips ABOVE its trigger
 * (the natural height doesn't fit below, and there is more room above), capped
 * to the room above; expanding "Buttons & menus" grows it upward from the
 * anchored bottom edge.
 */
function menuGeometry(adder: Box, k: number, pageTop: number) {
  const rows = addMenuRows(k);
  const bottom = adder.y - 4 * k;
  const room = adder.y - pageTop - 8 * k - 4 * k;
  return { rows, bottom, collapsedH: Math.min(rows.collapsedH, room), expandedH: Math.min(rows.expandedH, room) };
}

function menuState(frame: number, B: BuildBeats) {
  const open = ramp(frame, B.addContainerPress + 1, 4, EASE_RISE);
  const gone = ramp(frame, B.optionPress + 1, 4, EASE_UI);
  const expand = ramp(frame, B.groupPress + 1, 4, EASE_UI);
  const highlight: AddMenuItem = frame > B.groupPress ? "optionsMenu" : "buttonsMenus";
  return { visible: open > 0.001 && gone < 0.999, open, gone, expand, expanded: frame > B.groupPress, highlight };
}

/* ── Sounds ──────────────────────────────────────────────────────────────── */

const Sfx: React.FC<{ at: number; src: string; volume: number; frames: number }> = ({
  at: from,
  src,
  volume,
  frames,
}) => (
  <Sequence from={from} durationInFrames={frames}>
    <Audio src={staticFile(src)} volume={volume} />
  </Sequence>
);

/**
 * The scene's own sounds. The "checked" chime (CHIME_AT, in the pause after
 * "for you") rings past the build → assistant cut, so it lives in the film's
 * SFX track (src/sfxTrack.tsx), where it plays its full length.
 */
const BuildSfx: React.FC<{ presses: number[]; B: BuildBeats }> = ({ presses, B }) => (
  <>
    {presses.map((f, i) => (
      <Sfx key={`c${f}`} at={f} src={sfxVariant("click", i)} volume={VOL.click} frames={SFX_FRAMES.click} />
    ))}
    {KEY_FRAMES.map((f, i) => (
      <Sfx key={`k${f}`} at={f} src={sfxVariant("tick", i)} volume={VOL.tick} frames={SFX_FRAMES.tick} />
    ))}
    {/* A component (or image) appearing: the hero art landing, the button, the select. */}
    <Sfx at={B.dropPress + 8} src={sfxVariant("pop", 0)} volume={VOL.pop * 0.8} frames={SFX_FRAMES.pop} />
    <Sfx at={B.addButtonPress + 1} src={sfxVariant("pop", 1)} volume={VOL.pop} frames={SFX_FRAMES.pop} />
    <Sfx at={B.optionPress + 1} src={sfxVariant("pop", 2)} volume={VOL.pop} frames={SFX_FRAMES.pop} />
  </>
);

/* ── Shared per-frame props ──────────────────────────────────────────────── */

function useBuildFrame(B: BuildBeats) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const state = stateAt(frame, B);
  const sel = selectionAt(frame, B);
  const pop = (at: number) => settle(spring({ frame: frame - at, fps, config: { damping: 13, mass: 0.55, stiffness: 170 } }));
  const claimPop = frame > B.addButtonPress ? pop(B.addButtonPress + 1) : 0;
  const selectPop = frame > B.optionPress ? pop(B.optionPress + 1) : 0;
  const reveal = {
    claim: ramp(frame, B.addButtonPress + 1, 8, EASE_UI),
    row2: ramp(frame, B.optionPress + 1, 8, EASE_UI),
    select: ramp(frame, B.optionPress + 1, 8, EASE_UI),
  };
  const highlight = {
    claim: envelope(frame, B.addButtonPress + 1, B.addButtonPress + 30, 3, 12),
    row2: envelope(frame, B.optionPress + 1, B.optionPress + 30, 3, 12),
    select: envelope(frame, B.optionPress + 1, B.optionPress + 30, 3, 12),
  };
  // The pills tick when the counts change; the "checked" flash is the green ✓ state.
  const tick = Math.max(bump(frame, B.addButtonPress + 1), bump(frame, B.optionPress + 1));
  const pills = {
    ok: ramp(frame, OK_ON, 6, EASE_UI) * (1 - ramp(frame, OK_OFF, 10, EASE_UI)),
    tick: tick > 0 ? { components: tick, chars: tick } : undefined,
  };
  // The halo around the pills (build/PillsHalo.tsx): its ring is the ok state
  // itself, so it settles with the pills, before cut B; one ping leaves it as
  // the ✓ icons land, and the glow blooms with it.
  const ping = ramp(frame, OK_ON + 3, 16, (t) => t);
  const halo = {
    ping,
    bloom: envelope(frame, OK_ON, OK_ON + 18, 4, 12),
    visible: pills.ok > 0.001 || (ping > 0.001 && ping < 0.999),
  };
  const preview = {
    selected: sel,
    gallerySwap: heroSwap(frame, B),
    pop: { claim: frame > B.addButtonPress ? claimPop : undefined, select: frame > B.optionPress ? selectPop : undefined },
    glow: { claim: envelope(frame, B.addButtonPress + 1, B.addButtonPress + 32, 4, 14) },
  };
  return {
    frame,
    state,
    stats: campaignStats(state),
    sel,
    reveal,
    highlight,
    pills,
    halo,
    preview,
    editor: editorSlot(frame, state, B),
    menu: menuState(frame, B),
  };
}

export const SceneBuild: React.FC = () => {
  const vertical = useVertical();
  return (
    <AbsoluteFill>
      <Background glow={EDITOR_GLOW} />
      {vertical ? <BuildPortrait /> : <BuildLandscape />}
    </AbsoluteFill>
  );
};

/* ── Landscape ───────────────────────────────────────────────────────────── */

const BL = BEATS_L;

/** Tree layouts the pointer aims into (the renderer derives the same boxes). */
const textEditorOpen = { rowId: "text", height: TEXT_EDITOR_H, open: 1, node: null } as const;
const galleryEditorOpen = { rowId: "gallery", height: GALLERY_EDITOR_H, open: 1, node: null } as const;

const AIM_L = (() => {
  const stock = campaignState("stock");
  const retitled = campaignState("retitled");
  const reward = campaignState("reward");
  const text = treeBox(false, stock, "text");
  const editor = treeBox(false, stock, "editor:text", { editor: textEditorOpen });
  const gallery = treeBox(false, retitled, "gallery", { editor: textEditorOpen });
  const galleryEditor = treeBox(false, retitled, "editor:gallery", { editor: galleryEditorOpen });
  const addButton = treeBox(false, retitled, "addButton", { editor: galleryEditorOpen });
  const addContainer = treeBox(false, reward, "addToContainer");
  const zone = dropZone(galleryEditor, KL);
  const menu = menuGeometry(addContainer, KL, EDITOR_L.y + 1 + 45);
  const menuX = addContainer.x + 11 * KL + 190 * KL;
  const collapsedTop = menu.bottom - menu.collapsedH;
  const expandedTop = menu.bottom - menu.expandedH;
  return {
    // On the summary's middle: clear of the "Text" label, and a short hop to the heading after.
    text: { x: text.x + text.w * 0.66, y: text.cy },
    // "# " is ~13 world px at 15.4px Inter; "📢 Announcement" ends ~151 px in (measured on a still).
    selFrom: headingLinePoint(editor, KL, 13),
    selTo: headingLinePoint(editor, KL, 151),
    rest: { x: editor.x + editor.w - 14, y: editor.y + editor.h * 0.52 },
    gallery: { x: gallery.x + gallery.w * 0.86, y: gallery.cy },
    drop: dropAim(zone, KL),
    addButton: { x: addButton.x + adderWidth("Add button", KL) * 0.74, y: addButton.cy },
    addContainer: { x: addContainer.x + adderWidth("Add to container", KL) * 0.74, y: addContainer.cy },
    group: { x: menuX, y: collapsedTop + menu.rows.buttonsMenus },
    option: { x: menuX, y: expandedTop + menu.rows.optionsMenu },
    exit: { x: 690, y: 800 },
    menu,
  };
})();

/** The pointer: parked beside the tree at the cut, then every press of the build, then away. */
const POINTER_L: { before: Waypoint[]; after: Waypoint[] } = {
  before: [
    { f: T, ...TB_PARK_L },
    { f: T + 2, ...TB_PARK_L },
    { f: BL.textPress - 1, ...AIM_L.text },
    { f: BL.textPress, ...AIM_L.text, press: true },
    { f: BL.textPress + 5, ...AIM_L.text },
    { f: SEL_DOWN, ...AIM_L.selFrom },
  ],
  after: [
    { f: SEL_UP, ...AIM_L.selTo },
    // Out of the way of the line being typed.
    { f: SEL_UP + 7, ...AIM_L.rest },
    { f: BL.galleryPress - 9, ...AIM_L.rest },
    { f: BL.galleryPress - 1, ...AIM_L.gallery },
    { f: BL.galleryPress, ...AIM_L.gallery, press: true },
    { f: BL.galleryPress + 6, ...AIM_L.gallery },
    { f: BL.dropPress - 1, ...AIM_L.drop },
    { f: BL.dropPress, ...AIM_L.drop, press: true },
    { f: BL.dropPress + 6, ...AIM_L.drop },
    { f: BL.addButtonPress - 1, ...AIM_L.addButton },
    { f: BL.addButtonPress, ...AIM_L.addButton, press: true },
    { f: BL.addButtonPress + 5, ...AIM_L.addButton },
    { f: BL.addContainerPress - 1, ...AIM_L.addContainer },
    { f: BL.addContainerPress, ...AIM_L.addContainer, press: true },
    { f: BL.addContainerPress + 5, ...AIM_L.addContainer },
    { f: BL.groupPress - 1, ...AIM_L.group },
    { f: BL.groupPress, ...AIM_L.group, press: true },
    { f: BL.groupPress + 5, ...AIM_L.group },
    { f: BL.optionPress - 1, ...AIM_L.option },
    { f: BL.optionPress, ...AIM_L.option, press: true },
    { f: BL.optionPress + 5, ...AIM_L.option },
    { f: BL.optionPress + 22, ...AIM_L.exit },
  ],
};

/** The drag across the heading holds the button down and glides from start to end of the selection. */
function pointerL(frame: number) {
  if (frame < SEL_DOWN) return cursorAt(frame, POINTER_L.before);
  if (frame < SEL_UP) {
    return { x: mix(AIM_L.selFrom.x, AIM_L.selTo.x, dragT(frame)), y: AIM_L.selFrom.y, pressed: true, pressAge: null };
  }
  return cursorAt(frame, POINTER_L.after);
}

const PRESSES_L = [BL.textPress, SEL_DOWN, BL.galleryPress, BL.dropPress, BL.addButtonPress, BL.addContainerPress, BL.groupPress, BL.optionPress];

/** Tree hover/pressed: the pointer resting on a row or adder just before its press. */
function treeTouchL(frame: number) {
  const on = (at: number, id: string, lead = 2) => (frame >= at - lead && frame < at + 4 ? id : null);
  const hover =
    on(BL.textPress, "text") ?? on(BL.galleryPress, "gallery") ?? on(BL.addButtonPress, "addButton", 3) ?? on(BL.addContainerPress, "addToContainer", 3);
  const pressed =
    frame >= BL.addButtonPress && frame < BL.addButtonPress + 4
      ? "addButton"
      : frame >= BL.addContainerPress && frame < BL.addContainerPress + 4
        ? "addToContainer"
        : null;
  return { hover, pressed };
}

/** The stat pills' top-left in the window's overlay space (where the halo draws). */
const PILLS_L = pillsWindowL(KL);

const BuildLandscape: React.FC = () => {
  const f = useBuildFrame(BL);
  const { frame, menu } = f;
  const touch = treeTouchL(frame);
  const menuH = mix(AIM_L.menu.collapsedH, AIM_L.menu.expandedH, menu.expand);
  // Window-local px: the overlay's origin is inside the window's 1px border.
  const menuLeft = treeBox(false, f.state, "addToContainer", { reveal: f.reveal }).x - (EDITOR_L.x + 1);
  const menuTop = AIM_L.menu.bottom - menuH - (EDITOR_L.y + 1);

  return (
    <>
      <Camera shots={[{ f: T, ...EDITOR_WIDE_L }]}>
        <LandscapeAct
          state={f.state}
          bar={{ channel: CUT_B.channel, canUndo: CUT_B.canUndo, canRedo: CUT_B.canRedo }}
          pills={f.pills}
          tree={{ selected: f.sel, editor: f.editor, reveal: f.reveal, highlight: f.highlight, ...touch }}
          preview={f.preview}
          overlay={
            menu.visible || f.halo.visible ? (
              <>
                {menu.visible && (
                  <div
                    style={{
                      position: "absolute",
                      left: menuLeft,
                      top: menuTop,
                      opacity: menu.gone > 0 ? 1 - menu.gone : undefined,
                      transformOrigin: "bottom left",
                      transform: menu.gone > 0 ? `scale(${1 - 0.03 * menu.gone})` : undefined,
                    }}
                  >
                    <AddComponentMenu
                      expanded={menu.expanded}
                      highlight={menu.highlight}
                      reveal={menu.open}
                      width={460 * KL}
                      height={menuH}
                    />
                  </div>
                )}
                {/* The overlay clips to the window, so the ping can't spill past its edge. */}
                {f.halo.visible && (
                  <PillsHalo
                    x={PILLS_L.x}
                    y={PILLS_L.y}
                    components={f.stats.components}
                    chars={f.stats.chars}
                    ok={f.pills.ok}
                    ping={f.halo.ping}
                    bloom={f.halo.bloom}
                  />
                )}
              </>
            ) : undefined
          }
        />
        <Cursor {...pointerL(frame)} opacity={cursorOpacity(frame, [[-100, BL.optionPress + 24]], { fadeOut: 10 })} />
      </Camera>
      <BuildSfx presses={PRESSES_L} B={BL} />
    </>
  );
};

/* ── Portrait ────────────────────────────────────────────────────────────── */

const BV = BEATS_V;

/**
 * Tree scroll in the builder sheet (stage units): the acted-on row — and the
 * editor it unfolds — is brought into view, the way the product scrolls a
 * tapped row's editor into view and a new node into view after an add.
 */
const SCROLL_V = (() => {
  const stock = campaignState("stock");
  const retitled = campaignState("retitled");
  const reward = campaignState("reward");
  const select = campaignState("select");
  const origin = treeBox(true, stock, "container").y;
  const visible = SURFACE_V.y + SURFACE_V.h - origin;
  const top = (s: CampaignState, id: string, editor?: TreeEditorSlot) => treeBox(true, s, id, { editor }).y - origin;
  const bottom = (s: CampaignState, id: string, editor?: TreeEditorSlot) => {
    const b = treeBox(true, s, id, { editor });
    return b.y + b.h - origin;
  };
  return {
    /** The Text row at the top, its editor's textarea under it. */
    text: top(stock, "text"),
    /** Just far enough to show the gallery editor's drop zone under its row (a short, calm scroll). */
    gallery: Math.ceil(
      (() => {
        const zone = dropZone(treeBox(true, retitled, "editor:gallery", { editor: galleryEditorOpen }), KV);
        return zone.y + zone.h - origin - visible + 12;
      })(),
    ),
    /** The swipe: "+ Add button" in view below the still-open gallery editor. */
    swipe: Math.ceil(bottom(retitled, "addButton", galleryEditorOpen) - visible + 8),
    /** After the gallery editor folds the list is shorter: its end (Claim reward, both adders). */
    reward: Math.max(0, bottom(reward, "addToContainer") - visible),
    /** The new Action row + Options menu in view. */
    select: Math.ceil(bottom(select, "select") - visible + 10),
  };
})();

/**
 * The sheet's scroll through the beat. Scrolls the product does on its own
 * (revealing an editor, a new node) glide on the camera's gentle curve and
 * stay near the ~25 px/frame text limit on the canvas; the swipe follows the
 * finger 1:1; the fold after "+ Add button" moves with the editor collapsing.
 */
function treeScrollV(frame: number) {
  const s = SCROLL_V;
  const swipe = BV.swipe!;
  let v = s.text * ramp(frame, BV.textPress + 1, 12, DEFAULT_EASE);
  v = mix(v, 0, ramp(frame, BV.textClose! + 1, 10, DEFAULT_EASE));
  v = mix(v, s.gallery, ramp(frame, BV.galleryPress + 1, 13, DEFAULT_EASE));
  v = mix(v, s.swipe, ramp(frame, swipe.down, swipe.up - swipe.down, (t) => t));
  v = mix(v, s.reward, ramp(frame, BV.addButtonPress + 1, 7));
  v = mix(v, s.select, ramp(frame, BV.optionPress + 2, 14, DEFAULT_EASE));
  return mix(v, 0, ramp(frame, BV.settleTree, 44, DEFAULT_EASE));
}

/** Preview scroll: the button row, then the select, into view above the sheet; home before the cut. */
function previewScrollV(frame: number) {
  let v = 40 * ramp(frame, BV.addButtonPress - 8, 8);
  v = mix(v, 84, ramp(frame, BV.optionPress - 6, 6));
  return mix(v, 0, ramp(frame, BV.settlePreview, 24, DEFAULT_EASE));
}

type Touch = { at: number; x: number; y: number };

const TOUCH_V = (() => {
  const stock = campaignState("stock");
  const retitled = campaignState("retitled");
  const reward = campaignState("reward");
  const row = (b: Box) => ({ x: b.x + b.w * 0.86, y: b.cy });
  const editor = treeBox(true, stock, "editor:text", { editor: textEditorOpen, scroll: SCROLL_V.text });
  const galleryEditor = treeBox(true, retitled, "editor:gallery", { editor: galleryEditorOpen, scroll: SCROLL_V.gallery });
  const addButton = treeBox(true, retitled, "addButton", { editor: galleryEditorOpen, scroll: SCROLL_V.swipe });
  const addContainer = treeBox(true, reward, "addToContainer", { scroll: SCROLL_V.reward });
  const menu = menuGeometry(addContainer, KV, SURFACE_V.y);
  const menuX = addContainer.x + 11 * KV + 200 * KV;
  const taps: Touch[] = [
    { at: BV.textPress, ...row(treeBox(true, stock, "text")) },
    { at: BV.textClose!, ...row(treeBox(true, retitled, "text", { scroll: SCROLL_V.text })) },
    { at: BV.galleryPress, ...row(treeBox(true, retitled, "gallery")) },
    { at: BV.dropPress, ...dropAim(dropZone(galleryEditor, KV), KV) },
    { at: BV.addButtonPress, x: addButton.x + adderWidth("Add button", KV) * 0.74, y: addButton.cy },
    { at: BV.addContainerPress, x: addContainer.x + adderWidth("Add to container", KV) * 0.74, y: addContainer.cy },
    { at: BV.groupPress, x: menuX, y: menu.bottom - menu.collapsedH + menu.rows.buttonsMenus },
    { at: BV.optionPress, x: menuX, y: menu.bottom - menu.expandedH + menu.rows.optionsMenu },
  ];
  // The swipe starts on the (open) gallery editor, clear of its drop zone, and drags the list up.
  const swipeFrom = { x: galleryEditor.x + galleryEditor.w * 0.62, y: SURFACE_V.y + SURFACE_V.h - 34 };
  return {
    taps,
    swipeFrom,
    swipeTo: { x: swipeFrom.x, y: swipeFrom.y - (SCROLL_V.swipe - SCROLL_V.gallery) },
    // The same text at the portrait zoom (14 × 1.07 px).
    selFrom: headingLinePoint(editor, KV, 13 * (KV / KL)),
    selTo: headingLinePoint(editor, KV, 151 * (KV / KL)),
    menu,
    addContainer,
  };
})();

const PRESSES_V = [...TOUCH_V.taps.map((t) => t.at), SEL_DOWN].sort((a, b) => a - b);

/** A finger exists only while it is down: each tap lands, ripples and lifts; the selection is a drag. */
function touchPoseV(frame: number) {
  const fade = { fadeIn: 4, fadeOut: 4 };
  if (frame >= SEL_DOWN - 5 && frame < SEL_UP + 5) {
    return {
      pose: {
        x: mix(TOUCH_V.selFrom.x, TOUCH_V.selTo.x, dragT(frame)),
        y: TOUCH_V.selFrom.y,
        pressed: frame >= SEL_DOWN && frame < SEL_UP,
        pressAge: null,
      },
      opacity: cursorOpacity(frame, [[SEL_DOWN - 5, SEL_UP + 5]], fade),
    };
  }
  const swipe = BV.swipe!;
  if (frame >= swipe.down - 4 && frame < swipe.up + 4) {
    const t = ramp(frame, swipe.down, swipe.up - swipe.down, (x) => x);
    return {
      pose: {
        x: TOUCH_V.swipeFrom.x,
        y: mix(TOUCH_V.swipeFrom.y, TOUCH_V.swipeTo.y, t),
        pressed: frame >= swipe.down && frame < swipe.up,
        pressAge: null,
      },
      opacity: cursorOpacity(frame, [[swipe.down - 4, swipe.up + 4]], fade),
    };
  }
  const tap = TOUCH_V.taps.find((t) => frame >= t.at - 5 && frame < t.at + 5);
  if (!tap) return null;
  return {
    pose: { x: tap.x, y: tap.y, pressed: false, pressAge: frame >= tap.at ? frame - tap.at : null },
    opacity: cursorOpacity(frame, [[tap.at - 5, tap.at + 5]], fade),
  };
}

function treeTouchV(frame: number) {
  const on = (at: number | null, id: string) => (at !== null && frame >= at - 1 && frame < at + 4 ? id : null);
  return {
    hover: on(BV.addButtonPress, "addButton") ?? on(BV.addContainerPress, "addToContainer"),
    pressed: on(BV.addButtonPress, "addButton") ?? on(BV.addContainerPress, "addToContainer"),
  };
}

/** The phone's add menu is the single-column list (the product drops the preview pane under 600px). */
const PHONE_MENU_W = 320 * KV;

/** The stat pills in the builder sheet's header (surface-local px), at cut B's detent. */
const PILLS_V = pillsSurfaceV(CUT_B.sheetTop, KV);

const BuildPortrait: React.FC = () => {
  const f = useBuildFrame(BV);
  const { frame, menu } = f;
  const touch = touchPoseV(frame);
  const menuH = mix(TOUCH_V.menu.collapsedH, TOUCH_V.menu.expandedH, menu.expand);
  // Surface-local px: the overlay's origin is inside the surface's 1px border.
  const menuLeft = TOUCH_V.addContainer.x - SURFACE_V.x;
  const menuTop = TOUCH_V.menu.bottom - menuH - SURFACE_V.y;

  return (
    <>
      <Camera shots={[{ f: T, ...PORTRAIT_CAM }]}>
        <PortraitAct
          state={f.state}
          bar={{ channel: CUT_B.channel, canUndo: CUT_B.canUndo, canRedo: CUT_B.canRedo }}
          pills={f.pills}
          tree={{ selected: f.sel, editor: f.editor, reveal: f.reveal, highlight: f.highlight, scroll: treeScrollV(frame), ...treeTouchV(frame) }}
          preview={{ ...f.preview, scroll: previewScrollV(frame) }}
        />
        {menu.visible && (
          <SurfaceOverlayV>
            <div
              style={{
                position: "absolute",
                left: menuLeft,
                top: menuTop,
                width: PHONE_MENU_W,
                height: menuH,
                overflow: "hidden",
                borderRadius: 10 * KV,
                opacity: menu.gone > 0 ? 1 - menu.gone : undefined,
                transformOrigin: "bottom left",
                transform: menu.gone > 0 ? `scale(${1 - 0.03 * menu.gone})` : undefined,
              }}
            >
              {/* The two-pane menu cut to its list column: the phone layout. */}
              <AddComponentMenu
                expanded={menu.expanded}
                highlight={menu.highlight}
                reveal={menu.open}
                width={PHONE_MENU_W / 0.54}
                height={menuH}
              />
            </div>
          </SurfaceOverlayV>
        )}
        {f.halo.visible && (
          <SurfaceOverlayV>
            {/* Clipped to the builder sheet (its rounded top too), so the ping stays on the surface it belongs to. */}
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: CUT_B.sheetTop,
                bottom: 0,
                overflow: "hidden",
                borderRadius: "18px 18px 0 0",
              }}
            >
              <PillsHalo
                x={PILLS_V.x}
                y={PILLS_V.y - CUT_B.sheetTop}
                components={f.stats.components}
                chars={f.stats.chars}
                ok={f.pills.ok}
                ping={f.halo.ping}
                bloom={f.halo.bloom}
              />
            </div>
          </SurfaceOverlayV>
        )}
        {touch && <Cursor variant="touch" {...touch.pose} opacity={touch.opacity} />}
      </Camera>
      <BuildSfx presses={PRESSES_V} B={BV} />
    </>
  );
};
