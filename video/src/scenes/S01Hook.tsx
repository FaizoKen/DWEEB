import React from "react";
import { AbsoluteFill, Audio, Easing, Sequence, staticFile, useCurrentFrame } from "remotion";
import { Background } from "../components/Background";
import { Camera, Shot, useVertical } from "../components/Camera";
import type { CaptionCue } from "../components/Caption";
import { SFX_FRAMES, SHIMMER, VOL, WHOOSH } from "../audio";
import { at, atAbs, seqFrom } from "../timeline";
import { COLORS } from "../theme";
import { EDITOR_GLOW } from "./contracts";
import { LandscapeStage, MATCH_L, MATCH_V, PortraitStage, SHEET_HIDDEN } from "./hook/stage";

/**
 * HOOK — one Season 4 message, before and after. It opens tight on the bare
 * plain text ("Here's a boring Discord message"); in the VO pause a light
 * sweep crosses it and the finished card — the exact message the film later
 * delivers — is revealed behind the light while the plain text dissolves
 * ahead of it, the status chip turns PLAIN → UPGRADED, and the camera pulls
 * back to hold the whole card. In portrait the plain message opens centred
 * in the panel and the makeover carries it up into place as it transforms.
 * That held framing is the match cut into the reveal: the card is already
 * sitting in the editor's preview pane (see hook/stage.tsx), so the editor
 * can assemble around it.
 *
 * No channel, no competing chat (story lock): a neutral makeover surface.
 * The delivery ping stays exclusive to the send scene; the makeover's sound is
 * a soft whoosh + an in-key shimmer inside the VO's pause.
 */

/* ── Beats (scene-local = film frames: the hook starts at 0) ───────────── */

/** The VO pause between "…Discord message." and "Let's turn it…". */
const PAUSE = at("hook", "message", { edge: "end" });
const TURN = at("hook", "turn");
/** The sweep starts in the pause and has crossed the card by just after "turn". */
const SWEEP_START = PAUSE + 1;
const SWEEP_FRAMES = 18;
/** PLAIN → UPGRADED as the light passes the card's middle, just before "turn". */
const PILL_AT = TURN - 5;
const PILL_FRAMES = 4;
/**
 * Camera: a slow creep on the plain text, then the pull-back to the card,
 * starting as "message" is spoken and running through the turn.
 * Portrait starts earlier: at the 40 px push-in the card is wider than the
 * frame, and it must be whole by the time the light reaches its right side.
 */
const PULL_START = PAUSE - 8;
const SETTLE = PULL_START + 56;
const PULL_START_V = PAUSE - 12;
const SETTLE_V = PULL_START_V + 40;
/**
 * Portrait: the makeover carries the card up from the panel's middle into
 * its editor position, starting just ahead of the light so the light catches
 * it moving. Sine-eased like the camera pull it rides with: the two peak
 * together, and the text still moves ≤ 19 px/f.
 */
const LIFT_START_V = SWEEP_START - 10;
const LIFT_END_V = LIFT_START_V + 44;
/** Sound: the whoosh peaks with the light mid-pass; the shimmer's four notes
 *  arpeggiate (left→right, like the light) inside the pause. */
const WHOOSH_AT = SWEEP_START - 3;
const SHIMMER_AT = SWEEP_START + 2;

// The reveal starts cross-fading in at seqFrom("reveal"); the card is only
// registered if the camera (and the portrait card) is already still by then.
// A VO re-record that moves the pause late enough to break that must fail
// here, not ghost the match cut.
if (Math.max(SETTLE, SETTLE_V, LIFT_END_V) > seqFrom("reveal")) {
  throw new Error(
    `S01Hook: the pull-back settles at ${Math.max(SETTLE, SETTLE_V, LIFT_END_V)}, after the match cut starts (${seqFrom("reveal")}) — re-key the hook camera.`,
  );
}

const SWEEP_EASE = Easing.bezier(0.42, 0, 0.3, 1);
/**
 * Sine-shaped: peaks at 1.57× the average speed, where the default S-curve
 * would reach 2.3×. The landscape pull (a 2.2× zoom-out plus the drop to the
 * card's centre, over 56 frames) peaks at ≈ 24 px/f with it.
 */
const PULL_EASE = Easing.bezier(0.37, 0, 0.63, 1);
const sweepAt = (frame: number) =>
  frame <= SWEEP_START ? 0 : frame >= SWEEP_START + SWEEP_FRAMES ? 1 : SWEEP_EASE((frame - SWEEP_START) / SWEEP_FRAMES);

/* ── Framing ────────────────────────────────────────────────────────────── */

type Framing = { x: number; y: number; s: number };

const LINEAR = (t: number) => t;

/** The framing at zoom `s` that keeps world point `p` where `c` shows it. */
const holding = (p: { x: number; y: number }, c: Framing, s: number): Framing => ({
  x: p.x - ((p.x - c.x) * c.s) / s,
  y: p.y - ((p.y - c.y) * c.s) / s,
  s,
});

/**
 * A long zoom-out as per-frame keyframes: s is interpolated in log space
 * about the one world point both framings show at the same canvas spot, so
 * every point of the picture travels on a straight line toward it and the
 * zoom rate follows `ease` exactly. (Two plain keyframes interpolate x, y and
 * s linearly: over a 2× zoom the points then drift on curves and the zoom,
 * which goes as ds/s, peaks late.) The final keyframe is `to` itself, so the
 * settled framing is exact.
 */
const pullShots = (from: Framing, to: Framing, f0: number, f1: number, ease: (t: number) => number): Shot[] => {
  const k = from.s - to.s;
  const px = (from.x * from.s - to.x * to.s) / k;
  const py = (from.y * from.s - to.y * to.s) / k;
  const shots: Shot[] = [];
  for (let f = f0 + 1; f < f1; f++) {
    const s = from.s * Math.pow(to.s / from.s, ease((f - f0) / (f1 - f0)));
    shots.push({ f, ...holding({ x: px, y: py }, from, s), ease: LINEAR });
  }
  shots.push({ f: f1, ...to, ease: LINEAR });
  return shots;
};

/**
 * Landscape opens tight on the plain message with the title bar's PLAIN chip
 * above it (text ≈ 45 px), creeping in on the message's centre. The frame
 * sits a little left of the message so the BEFORE plate (bottom-left) covers
 * only the empty column under the avatar: the light reveals the card there
 * while the plate is still fading, and a plate must never cover the element
 * that is changing.
 */
const PLAIN_CENTRE_L = { x: 1195, y: 215 } as const; // measured: avatar 912 … text end 1478, y 166–265
const CREEP_L: Framing = { x: 1134, y: 195, s: 2.55 };
const OPEN_L = holding(PLAIN_CENTRE_L, CREEP_L, 2.48);
const OPEN_V = { x: 906, y: 484, s: 2.5 } as const;
const CREEP_V = { x: 906, y: 482, s: 2.54 } as const;
/**
 * Portrait: the plain message opens this far (surface units) below its editor
 * spot — centred in the panel under the title bar rather than hanging from it
 * over an empty screen — and rides up as it transforms.
 */
const LIFT_V = 168;
const liftAt = (frame: number) =>
  frame <= LIFT_START_V ? LIFT_V : frame >= LIFT_END_V ? 0 : LIFT_V * (1 - PULL_EASE((frame - LIFT_START_V) / (LIFT_END_V - LIFT_START_V)));

const SHOTS_L: Shot[] = [
  { f: 0, ...OPEN_L },
  { f: PULL_START, ...CREEP_L },
  ...pullShots(CREEP_L, MATCH_L, PULL_START, SETTLE, PULL_EASE),
];
const SHOTS_V: Shot[] = [
  { f: 0, ...OPEN_V },
  { f: PULL_START_V, ...CREEP_V },
  { f: SETTLE_V, ...MATCH_V, ease: PULL_EASE },
];

/* ── Captions (absolute frames; the top-level CaptionTrack renders them) ── */

/** The reveal's brand lockup takes the portrait caption band from here. */
const LOCKUP_ABS = atAbs("reveal", "DWEEB", { offset: -8 });
/**
 * Landscape: while the camera pulls back, the tall card sweeps through the
 * bottom-left caption column, so AFTER rises only once the card's content is
 * clear of the plate (true from 30 frames before the settle, checked against
 * the shot list) and holds a little longer into the reveal, where nothing
 * shares that corner.
 */
const AFTER_L = SETTLE - 24;
const BEFORE = { label: "BEFORE", parts: [{ text: "Just plain text.", hl: true }], accent: COLORS.warning };
const AFTER = { label: "AFTER", parts: ["Clear. Visual.", { text: "Interactive.", hl: true }], accent: COLORS.green };

export const captions: CaptionCue[] = [
  // Both BEFOREs rise with the picture's fade-in. In landscape BEFORE fades
  // through the VO pause and is gone before the light reveals the card's
  // lower-left under it; the makeover itself plays without a super.
  { id: "hook-before", ...BEFORE, aspect: "landscape", from: 6, to: TURN - 7 },
  { id: "hook-after", ...AFTER, aspect: "landscape", from: AFTER_L, to: AFTER_L + 72 },
  // Portrait supers live in the top band, clear of the card: AFTER lands with
  // the card, holds across the match cut, and clears as the reveal's VO begins
  // — when the brand lockup needs the band.
  { id: "hook-before-v", ...BEFORE, aspect: "vertical", from: 6, to: TURN - 7 },
  { id: "hook-after-v", ...AFTER, aspect: "vertical", from: TURN - 7, to: LOCKUP_ABS },
];

export const SceneHook: React.FC = () => {
  const frame = useCurrentFrame();
  const vert = useVertical();
  const sweep = sweepAt(frame);
  const upgraded = Math.max(0, Math.min(1, (frame - PILL_AT) / PILL_FRAMES));

  return (
    <AbsoluteFill>
      <Background glow={EDITOR_GLOW} />
      <Camera shots={vert ? SHOTS_V : SHOTS_L} blur={0.8}>
        {vert ? (
          <PortraitStage
            sweep={sweep}
            upgraded={upgraded}
            title={1}
            band={1}
            lift={liftAt(frame)}
            assembly={{ bar: 0, sheetY: SHEET_HIDDEN, rows: {} }}
          />
        ) : (
          <LandscapeStage
            sweep={sweep}
            upgraded={upgraded}
            title={1}
            panel={1}
            assembly={{ chrome: 0, left: 0, fabs: 0, rows: {} }}
          />
        )}
      </Camera>

      <Sequence from={WHOOSH_AT} durationInFrames={SFX_FRAMES.whoosh} name="makeover whoosh">
        <Audio src={staticFile(WHOOSH)} volume={VOL.whoosh} />
      </Sequence>
      <Sequence from={SHIMMER_AT} durationInFrames={SFX_FRAMES.shimmer} name="makeover shimmer">
        <Audio src={staticFile(SHIMMER)} volume={VOL.shimmer} />
      </Sequence>
    </AbsoluteFill>
  );
};

