import React from "react";
import { AbsoluteFill, Audio, Easing, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Background } from "../components/Background";
import { Camera, Shot, useVertical } from "../components/Camera";
import type { CaptionCue } from "../components/Caption";
import { settle } from "../components/Bits";
import { CHIME, SFX_FRAMES, VOL, sfxVariant } from "../audio";
import { SCENES, TRANSITION_FRAMES, at, atAbs, speechStartAbs } from "../timeline";
import { COLORS } from "../theme";
import { CUT_A, EDITOR_GLOW, EDITOR_WIDE_L } from "./contracts";
import { FINAL, LandscapeStage, MATCH_L, MATCH_V, PortraitStage, SHEET_HIDDEN, type StageSheen } from "./hook/stage";
import { campaignAdders, campaignRows } from "../story/campaign";
import { BrandLockup, type LockupSize } from "./reveal/lockup";

/**
 * REVEAL — "Meet DWEEB: the visual Discord message builder…". The hook's card
 * is already in the editor's preview pane; the reveal builds the editor around
 * it, and ends on cut A — the plain, fully assembled editor, held still.
 *
 *  0–16   the match cut: static, the exact frame the hook ends on.
 *  16→    landscape pulls back (short, slow) to the whole-window wide and is
 *         settled as the name is spoken; portrait stays locked.
 *  "DWEEB" the brand lockup lands, crisp, in frame, with a pop — in the
 *         builder column (landscape) / the top band (portrait).
 *  "the visual Discord message builder" the lockup clears and the builder
 *         assembles: browser chrome drops over the makeover title bar, the
 *         builder pane slides in (portrait: the action bar drops into the title
 *         band and the builder sheet slides up over the card), rows populate.
 *  "Components V2" the settled editor catches the light once: it runs down
 *         the tree's component glyphs, then crosses the card (the makeover's
 *         light, narrower and fainter) — the one move in an otherwise still wide.
 *  end    whole-window wide, nothing in flight = cut A (contracts.ts).
 */

const T = TRANSITION_FRAMES;

/* ── Beats (scene-local) ────────────────────────────────────────────────── */

const DWEEB = at("reveal", "DWEEB");
/** The pause after the name, before "the visual…". */
const DWEEB_END = at("reveal", "DWEEB", { edge: "end" });
const THE_VISUAL = at("reveal", "the visual");

/** The lockup enters 8 frames before the name, so the whole word reads on it. */
const LOCKUP_IN = DWEEB - 8;
/** It holds through "the visual" and lifts away as the builder assembles. */
const LOCKUP_OUT = THE_VISUAL + 10;
/** Assembly on "…Discord message builder": chrome / action bar as the lockup
 *  lifts (the title bar's text clears just before), then the pane / sheet. */
const CHROME_AT = LOCKUP_OUT + 2;
const TITLE_OUT = CHROME_AT - 4;
const PANE_AT = CHROME_AT + 6;
const SHEET_AT = CHROME_AT + 4;
const SHEET_FRAMES = 24;
/** Rows populate top-down as the pane lands, under "for webhooks, embeds…". */
const ROWS_AT = PANE_AT + 8;
const ROW_STAGGER = 4;
/** The makeover panel is fully behind the assembled window by now. */
const PANEL_OUT = ROWS_AT + 12;
/**
 * "…and Components V2": after the assembly the wide would otherwise sit
 * perfectly still for two seconds. On "Components" a glint runs down the
 * tree's glyph tiles, one row after another; on "V2" the light crosses the
 * card. A film light — nothing in the UI changes — and it is over at least
 * T frames before cut A, so the hold cut still opens on a still frame.
 */
const GLINT_AT = at("reveal", "Components", { offset: -2 });
const GLINT_STAGGER = 1.5;
const GLINT_FRAMES = 8;
const SHEEN_AT = at("reveal", "V2", { offset: -5 });
const SHEEN_FRAMES = 14;

/* ── Framing ────────────────────────────────────────────────────────────── */

/** Static on the match framing through the overlap, then a short pull to the
 *  wide that has settled by the name. */
const SHOTS_L: Shot[] = [
  { f: 0, ...MATCH_L },
  { f: T, ...MATCH_L },
  { f: DWEEB, ...EDITOR_WIDE_L },
];
const SHOTS_V: Shot[] = [{ f: 0, ...MATCH_V }];

/**
 * Lockups. Landscape: the brand's stacked lockup, centred in the builder
 * column the pane will slide over (world x 120…720), level with the card.
 * Portrait: the row variant, centred in the top band the AFTER super has just
 * vacated (canvas y ≈ 245–380; world units are half canvas px there).
 */
const LOCKUP_L: LockupSize = { layout: "stacked", mascot: 104, word: 84, line: 24, gap: 22 };
const LOCKUP_L_CENTER = { x: 420, y: 470 } as const;
const LOCKUP_V: LockupSize = { layout: "row", mascot: 60, word: 36, line: 14, gap: 14 };
const LOCKUP_V_CENTER = { x: 960, y: 216 } as const;

/** Tree entrance order: the rows and adders as the tree lays them out. */
const ROW_ORDER: string[] = (() => {
  const rows = campaignRows(FINAL).map((r) => r.id);
  const adders = campaignAdders(FINAL);
  const out: string[] = [];
  for (const id of rows) {
    out.push(id);
    for (const a of adders) if (a.after === id && a.id === "addButton") out.push(a.id);
  }
  out.push("addToContainer");
  return out;
})();

/**
 * Beat sanity, checked at load so a VO re-record fails loudly: the lockup must
 * not start during the match overlap, and the editor must be fully assembled
 * (the last row's spring snapped to 1 — it needs 16 frames; 20 allowed) with
 * at least T still frames before cut A, which the templates scene opens on.
 */
const ROW_SETTLE = 20;
const ASSEMBLED_BY = ROWS_AT + (ROW_ORDER.length - 1) * ROW_STAGGER + ROW_SETTLE;
const LAST_FRAME = SCENES.reveal.durationInFrames + T - 1;
/** The tree's rows, in order (the glint's cascade). */
const TREE_ROWS = campaignRows(FINAL).length;
const LIGHT_DONE = Math.max(GLINT_AT + (TREE_ROWS - 1) * GLINT_STAGGER + GLINT_FRAMES, SHEEN_AT + SHEEN_FRAMES);
if (LOCKUP_IN <= T || ASSEMBLED_BY > LAST_FRAME - T) {
  throw new Error(
    `S02Reveal: beats no longer fit the VO (lockup in at ${LOCKUP_IN}, match overlap ends at ${T}; assembled by ${ASSEMBLED_BY}, cut A at ${LAST_FRAME}) — re-key them.`,
  );
}
// The light plays on the settled editor only, and ends T frames before cut A.
if (GLINT_AT < ASSEMBLED_BY || SHEEN_AT < ASSEMBLED_BY || LIGHT_DONE > LAST_FRAME - T) {
  throw new Error(
    `S02Reveal: the "Components V2" light (${GLINT_AT}–${LIGHT_DONE}) no longer sits between the assembly (${ASSEMBLED_BY}) and cut A − T (${LAST_FRAME - T}) — re-key it.`,
  );
}

/* ── Captions ───────────────────────────────────────────────────────────── */

/**
 * MEET DWEEB rises as the lockup hands the screen to the builder, on "…Discord
 * message builder": the lockup already says the name and the product line on
 * "DWEEB", so the super follows it rather than repeating it beside it — and
 * in portrait the top band is free again. It clears before the templates line.
 */
export const captions: CaptionCue[] = [
  {
    id: "reveal",
    label: "MEET DWEEB",
    parts: ["The visual", { text: "Discord message builder.", hl: true }],
    // The lockup has cleared by now (LOCKUP_OUT + 10 = "the visual" + 20).
    from: atAbs("reveal", "the visual", { offset: 20 }),
    to: speechStartAbs("templates") - 6,
    accent: COLORS.blurple,
  },
];

/** The lockup centred on a world point. */
const LockupAt: React.FC<{ center: { x: number; y: number }; size: LockupSize }> = ({ center, size }) => (
  <div style={{ position: "absolute", left: center.x, top: center.y, transform: "translate(-50%, -50%)" }}>
    <BrandLockup size={size} enter={LOCKUP_IN} exit={LOCKUP_OUT} />
  </div>
);

/* ── Scene ──────────────────────────────────────────────────────────────── */

/** A sheet rising from below: quick off the mark (≈2.4× average speed), long settle. */
const SHEET_EASE = Easing.bezier(0.25, 0.6, 0.3, 1);

export const SceneReveal: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const vert = useVertical();

  const spr = (from: number, config: { damping?: number; mass?: number; stiffness?: number } = {}) =>
    settle(spring({ frame: frame - from, fps, config: { damping: 19, mass: 0.7, stiffness: 140, ...config } }));
  const ramp = (from: number, frames: number) => Math.max(0, Math.min(1, (frame - from) / frames));

  // Only mounted while it is on screen, so the match-cut frames carry nothing extra.
  const lockupOn = frame >= LOCKUP_IN && frame < LOCKUP_OUT + 10;
  const title = 1 - ramp(TITLE_OUT, 6);
  const rows: Record<string, number> = {};
  ROW_ORDER.forEach((id, i) => {
    rows[id] = spr(ROWS_AT + i * ROW_STAGGER, { damping: 18, mass: 0.6, stiffness: 170 });
  });
  const rowsDone = ROW_ORDER.every((id) => rows[id] >= 1);
  const sheen: StageSheen = {
    tile: (row) => ramp(GLINT_AT + row * GLINT_STAGGER, GLINT_FRAMES),
    card: ramp(SHEEN_AT, SHEEN_FRAMES),
  };

  let stage: React.ReactNode;
  if (vert) {
    const bar = spr(CHROME_AT);
    const sheetT = SHEET_EASE(ramp(SHEET_AT, SHEET_FRAMES));
    const sheetY = SHEET_HIDDEN + (CUT_A.sheetTop - SHEET_HIDDEN) * sheetT;
    const settled = bar >= 1 && sheetT >= 1 && rowsDone;
    stage = (
      <PortraitStage
        sweep={1}
        upgraded={1}
        title={title}
        // The title bar's fill gives way as the action bar lands in its band.
        band={1 - bar}
        assembly={settled ? undefined : { bar, sheetY, rows }}
        sheen={sheen}
      />
    );
  } else {
    const chrome = spr(CHROME_AT);
    const left = spr(PANE_AT, { damping: 20, mass: 0.7, stiffness: 130 });
    const fabs = ramp(PANE_AT + 10, 10);
    const panel = 1 - ramp(PANEL_OUT, 10);
    const settled = chrome >= 1 && left >= 1 && fabs >= 1 && rowsDone;
    stage = (
      <LandscapeStage
        sweep={1}
        upgraded={1}
        title={title}
        panel={panel}
        assembly={settled ? undefined : { chrome, left, fabs, rows }}
        sheen={sheen}
      />
    );
  }

  return (
    <AbsoluteFill>
      <Background glow={EDITOR_GLOW} />
      <Camera shots={vert ? SHOTS_V : SHOTS_L} blur={0.6}>
        {stage}
        {/* Above the forming window: it lifts away cleanly instead of being
            dimmed behind the shell, and is gone before the pane's content shows. */}
        {lockupOn && <LockupAt center={vert ? LOCKUP_V_CENTER : LOCKUP_L_CENTER} size={vert ? LOCKUP_V : LOCKUP_L} />}
      </Camera>

      {/* The name lands with a pop; the chime answers in the pause after it. */}
      <Sequence from={DWEEB} durationInFrames={SFX_FRAMES.pop} name="brand pop">
        <Audio src={staticFile(sfxVariant("pop", 0))} volume={VOL.pop * 1.3} />
      </Sequence>
      <Sequence from={DWEEB_END + 1} durationInFrames={SFX_FRAMES.chime} name="brand chime">
        <Audio src={staticFile(CHIME)} volume={VOL.chime} />
      </Sequence>
    </AbsoluteFill>
  );
};
