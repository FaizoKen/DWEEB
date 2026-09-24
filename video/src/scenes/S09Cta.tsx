import React from "react";
import {
  AbsoluteFill,
  Audio,
  Easing,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Background } from "../components/Background";
import { settle } from "../components/Bits";
import { Camera, RECOIL_EASE, Shot, useVertical } from "../components/Camera";
import type { CaptionCue } from "../components/Caption";
import { Cursor, PRESS_FRAMES, cursorAt, cursorOpacity, type Waypoint } from "../components/Cursor";
import { CHIME, IMPACT, IMPACT_FRAMES, SFX_FRAMES, VOL, sfxVariant } from "../audio";
import { INTER } from "../fonts";
import { withAlpha } from "../lib/color";
import { COLORS } from "../theme";
import { FPS, MUSIC_MARKS, TOTAL, TRANSITION_FRAMES, at, seqFrom, speechEnd } from "../timeline";
import { GazeMascot } from "./cta/GazeMascot";
import { Headline, SLAM_LANDS_AFTER, SLAM_SETTLES_AFTER, headlineWordCount } from "./cta/Headline";
import { LAYOUT_L, LAYOUT_V, gCenter, headlineBottom, zoomAbout, type CtaLayout } from "./cta/layout";
import { G_RIPPLE_FRAMES, QUERY, ResultCard, SearchBar } from "./cta/Search";

/**
 * CTA — the end card, entered by a HARD CUT on the film's climax.
 *
 * The cut frame is CTA_HIT_ABS (scene-local TRANSITION_FRAMES): the riser
 * peaks, the score drops into main B, and on that same first visible frame the
 * impact sounds, a photographic flash fires, the camera recoils about the word
 * and BUILD slams onto its baseline. (The layer is not mounted before the cut,
 * so nothing here may start earlier.) The promise then lands word by word with
 * the narrator — BETTER · DISCORD · MESSAGES. — and the action follows the
 * story lock: the mascot pops up behind a Google-style search bar, "DWEEB
 * Discord builder" types itself under "Start free today", the G at the far end
 * is pressed as the line ends, and the result card lands on the score's outro
 * crash. Then nothing moves for more than two seconds before the fade.
 *
 * No caption: the end card is the type.
 */
export const captions: CaptionCue[] = [];

/* ── Beats (scene-local frames; the cut is at HIT) ─────────────────────── */

/** The hard cut: first visible frame, the drop, the impact. */
const HIT = TRANSITION_FRAMES;

/**
 * Headline words, in reading order: each starts SLAM_LANDS_AFTER (4) frames
 * ahead of its spoken word, so it is visible from 3–4 frames before the word
 * and lands on it. BUILD is the exception by design: it lands ON the hit (its
 * rise runs in the unmounted frames before the cut), 12 frames ahead of
 * "Build" — at the climax the drop is its cue, and the narrator follows it.
 */
const WORD_STARTS = [
  HIT - SLAM_LANDS_AFTER,
  at("cta", "better", { offset: -SLAM_LANDS_AFTER }),
  at("cta", "Discord", { offset: -SLAM_LANDS_AFTER }),
  at("cta", "messages", { offset: -SLAM_LANDS_AFTER }),
];
/** The gradient rule draws under MESSAGES. once it has landed. */
const UNDERLINE_IN = WORD_STARTS[3] + SLAM_LANDS_AFTER + 2;
const UNDERLINE_FRAMES = 22;

/** The search bar rises just after "messages" lands — the promise is read by then. */
const BAR_IN = at("cta", "messages", { offset: 5 });
/** The mascot pops up behind it as "messages" ends (on the score's downbeat). */
const MASCOT_POP = at("cta", "messages", { edge: "end", offset: -4 });
/** The query types itself under "Start free today", from the breath before "Start". */
const TYPE_START = at("cta", "Start", { offset: -10 });
/** The G is pressed once the line has ended (the bar's fourth beat here). */
const PRESS = speechEnd("cta") + 2;
/** The pointer has reached the G and hovers it this long before pressing. */
const ARRIVE = PRESS - 6;
/**
 * The result card lands on the score's outro crash (MUSIC_MARKS.ending) — the
 * film's last musical accent — unrolling from under the bar after a beat of
 * "search latency". Without a built score it lands 15 frames after the press.
 */
const CTA_SEQ = seqFrom("cta");
const RESULT_LAND = MUSIC_MARKS?.ending != null ? MUSIC_MARKS.ending - CTA_SEQ : PRESS + 15;
const RESULT_FRAMES = 11;
const RESULT_IN = RESULT_LAND - RESULT_FRAMES;

/** Camera: a 6% kick at the hit that recoils in 20 frames, then a slow push that ends with the result. */
const KICK = 1.06;
const RECOIL_FRAMES = 20;

/**
 * Everything has stopped moving from here: the result card lands last (the
 * camera's push ends with it); the checks below keep the rest earlier.
 */
const SETTLED = RESULT_LAND;

/**
 * Keystroke rhythm for QUERY (frames since the previous key): quick inside a
 * word, a beat longer across the spaces — a person typing, not a ticker. One
 * key per frame at most, so every key gets its own tick.
 */
const KEY_GAPS = [
  0, 1.5, 1.5, 1.25, 1.5, 2, 2, 1.25, 1.25, 1.5, 1.25, 1.25, 1.5, 2, 2, 1.25, 1.25, 1.25, 1.25, 1.5, 1.25,
];
const KEYS: number[] = [];
KEY_GAPS.reduce((elapsed, gap) => {
  KEYS.push(TYPE_START + Math.round(elapsed + gap));
  return elapsed + gap;
}, 0);
const TYPE_END = KEYS[KEYS.length - 1];

/** The pointer is gone by here (both aspects' fade windows end earlier). */
const POINTER_GONE = PRESS + 13;
/** Scene-local frame the film's tail fade (DweebPromo Fades: TOTAL − 20) starts. */
const FADE_START = TOTAL - 20 - CTA_SEQ;

// Fail at load — not as a quietly broken end card — if a re-timed VO or score
// squeezes the choreography.
{
  const problems: string[] = [];
  for (const [name, l] of [
    ["landscape", LAYOUT_L],
    ["vertical", LAYOUT_V],
  ] as const) {
    if (headlineWordCount(l) !== WORD_STARTS.length) {
      problems.push(`the ${name} headline has ${headlineWordCount(l)} words for ${WORD_STARTS.length} spoken anchors`);
    }
  }
  if (KEY_GAPS.length !== QUERY.length)
    problems.push(`KEY_GAPS has ${KEY_GAPS.length} gaps for ${QUERY.length} characters`);
  if (KEYS.some((k, i) => i > 0 && k <= KEYS[i - 1])) problems.push("two keystrokes share a frame");
  if (BAR_IN <= WORD_STARTS[3]) problems.push("the search bar rises before MESSAGES. has started");
  if (TYPE_START < BAR_IN + 12)
    problems.push(`typing (${TYPE_START}) starts before the bar has landed (${BAR_IN + 12})`);
  if (TYPE_END > ARRIVE - 2) problems.push(`typing ends at ${TYPE_END}, after the pointer reaches the G (${ARRIVE})`);
  if (RESULT_IN < PRESS + PRESS_FRAMES)
    problems.push(`the result (${RESULT_IN}) would appear before the press releases (${PRESS + PRESS_FRAMES})`);
  const lateMovers = {
    "the last headline word": WORD_STARTS[3] + SLAM_SETTLES_AFTER,
    "the underline": UNDERLINE_IN + UNDERLINE_FRAMES,
    "the pointer": POINTER_GONE,
    "the blink": PRESS + 5,
    "the G's ink ripple": PRESS + G_RIPPLE_FRAMES,
  };
  for (const [what, done] of Object.entries(lateMovers)) {
    if (done > SETTLED) problems.push(`${what} still moves at ${done}, after the end card settles (${SETTLED})`);
  }
  if (FADE_START - SETTLED < 2 * FPS) {
    problems.push(`the settled end card holds ${FADE_START - SETTLED} frames before the fade; it needs ≥ ${2 * FPS}`);
  }
  if (problems.length) throw new Error(`S09Cta: ${problems.join("; ")}. Re-key the end card.`);
}

/* ── Framing ───────────────────────────────────────────────────────────── */

/** World point at the centre of BUILD (the first word): the recoil scales about it. */
const buildCentre = (l: CtaLayout) => ({
  x: l.headline.x + l.headline.lines[0].size * 1.35,
  y: l.headline.y + l.headline.lines[0].size * 0.45,
});

const shotsFor = (l: CtaLayout): Shot[] => [
  { f: HIT, ...zoomAbout(l.cam, buildCentre(l), KICK) },
  { f: HIT + RECOIL_FRAMES, ...l.cam, ease: RECOIL_EASE },
  { f: SETTLED, ...zoomAbout(l.cam, l.push.pivot, l.push.k) },
];
const SHOTS_L = shotsFor(LAYOUT_L);
const SHOTS_V = shotsFor(LAYOUT_V);

/* ── Pointer (landscape arrow / vertical touch) ────────────────────────── */

const G_L = gCenter(LAYOUT_L.bar);
const G_V = gCenter(LAYOUT_V.bar);
/** The arrow glides in from the lower right and rests with its tip on the G. */
const POINTER_L: Waypoint[] = [
  { f: PRESS - 24, x: G_L.x + 210, y: G_L.y + 250 },
  { f: ARRIVE, x: G_L.x + 4, y: G_L.y + 3 },
  { f: PRESS, x: G_L.x + 4, y: G_L.y + 3, press: true },
];
const POINTER_L_ON: [number, number][] = [[PRESS - 24, POINTER_GONE]];
/** A fingertip settles onto the G and taps it. */
const POINTER_V: Waypoint[] = [
  { f: PRESS - 8, x: G_V.x + 14, y: G_V.y + 22 },
  { f: PRESS - 1, x: G_V.x, y: G_V.y },
  { f: PRESS, x: G_V.x, y: G_V.y, press: true },
];
const POINTER_V_ON: [number, number][] = [[PRESS - 8, POINTER_GONE - 1]];

/* ── Mascot gaze (pupil offsets in the drawing's 512-unit space) ───────── */

type Gaze = { f: number; x: number; y: number };
/** It pops up looking at you, watches the query type, the G being pressed, then the result it found. */
const GAZE: Gaze[] = [
  { f: MASCOT_POP, x: 0, y: -4 },
  { f: TYPE_START, x: 0, y: -4 },
  { f: TYPE_START + 4, x: -22, y: 12 },
  { f: TYPE_END, x: -9, y: 12 },
  { f: ARRIVE - 4, x: -9, y: 12 },
  { f: ARRIVE, x: 16, y: 16 },
  { f: RESULT_IN, x: 16, y: 16 },
  { f: RESULT_IN + 4, x: -6, y: 22 },
];
const smooth = (t: number) => t * t * (3 - 2 * t);
const gazeAt = (frame: number) => {
  if (frame <= GAZE[0].f) return GAZE[0];
  for (let i = 1; i < GAZE.length; i++) {
    const a = GAZE[i - 1];
    const b = GAZE[i];
    if (frame <= b.f) {
      const t = smooth((frame - a.f) / (b.f - a.f));
      return { f: frame, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
  }
  return GAZE[GAZE.length - 1];
};
/** One blink, startled by the click. */
const BLINK = [1, 0.4, 0.1, 0.45, 1];
const eyeOpen = (frame: number) => BLINK[frame - PRESS] ?? 1;

/* ── Pieces ────────────────────────────────────────────────────────────── */

const BAR_SPRING = { damping: 20, mass: 0.6, stiffness: 170 } as const;
const POP_SPRING = { damping: 12, mass: 0.55, stiffness: 190 } as const;
const RESULT_EASE = Easing.bezier(0.16, 1, 0.3, 1);
const UNDERLINE_EASE = Easing.bezier(0.3, 0.7, 0.2, 1);

/** A cool, faint wash that separates the end card from the stage's default look. */
const TINT = "linear-gradient(104deg, rgba(88,101,242,.09), transparent 34%, transparent 67%, rgba(87,242,135,.06))";

/**
 * The photographic flash on the hit, 0–1: at full strength on the cut frame
 * (the first frame anyone sees), then an exponential decay — a flash has no
 * attack — more than halving every frame, gone within 6.
 *
 * It is drawn as EXPOSURE, not as a white layer: a translucent white over a
 * dark card can only wash it grey (v5's flash read as fog). A brightness lift
 * blows BUILD out to white and flares the stage's glows in colour, and a light
 * screen-blended burst from BUILD (the recoil's pivot) adds the bloom.
 */
const flashAt = (frame: number) => {
  if (frame < HIT) return 0;
  const v = Math.exp(-(frame - HIT) / 1.3);
  return v < 0.012 ? 0 : v;
};
/** Canvas position of BUILD's centre at rest — the flash's core. */
const flashOrigin = (l: CtaLayout, width: number, height: number) => {
  const p = buildCentre(l);
  return { x: (p.x - l.cam.x) * l.cam.s + width / 2, y: (p.y - l.cam.y) * l.cam.s + height / 2 };
};

/** The brand in the corner, on screen from the cut (the hit reveals a finished card). */
const CornerWordmark: React.FC<{ l: CtaLayout }> = ({ l }) => (
  <div
    style={{
      position: "absolute",
      left: l.wordmark.x,
      top: l.wordmark.y,
      fontFamily: INTER,
      fontSize: l.wordmark.size,
      fontWeight: 900,
      lineHeight: 1,
      letterSpacing: "0.06em",
      color: COLORS.text,
      textShadow: `0 ${l.wordmark.size * 0.1}px ${l.wordmark.size * 0.5}px rgba(0,0,0,.5)`,
      whiteSpace: "nowrap",
    }}
  >
    DWEEB
  </div>
);

export const SceneCta: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const vert = useVertical();
  const l = vert ? LAYOUT_V : LAYOUT_L;

  // Underline under MESSAGES.
  const rule = UNDERLINE_EASE(
    interpolate(frame, [UNDERLINE_IN, UNDERLINE_IN + UNDERLINE_FRAMES], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    }),
  );

  // Search bar entrance.
  const barP = frame < BAR_IN ? 0 : settle(spring({ frame: frame - BAR_IN, fps, config: BAR_SPRING }));
  const typedCount = KEYS.filter((k) => k <= frame).length;
  // Caret: focused once the bar has landed; solid while keys arrive (a real
  // caret never blinks mid-word), blinking when idle, gone once the search is sent.
  const focusAt = BAR_IN + 10;
  const idleSince = frame < TYPE_START ? focusAt : TYPE_END + 2;
  const typing = frame >= TYPE_START && frame < TYPE_END + 2;
  const caret = frame >= focusAt && frame < PRESS && (typing || Math.floor((frame - idleSince) / 16) % 2 === 0);

  // Mascot pop, from behind the bar.
  const popP = frame < MASCOT_POP ? 0 : settle(spring({ frame: frame - MASCOT_POP, fps, config: POP_SPRING }));

  // Pointer and the G's hover / press.
  const pose = cursorAt(frame, vert ? POINTER_V : POINTER_L);
  const pointerOpacity = vert
    ? cursorOpacity(frame, POINTER_V_ON, { fadeIn: 4, fadeOut: 5 })
    : cursorOpacity(frame, POINTER_L_ON, { fadeIn: 6, fadeOut: 6 });
  const g = vert ? G_V : G_L;
  const overG =
    !vert && pointerOpacity > 0.5 && Math.abs(pose.x - g.x) < l.bar.gW / 2 && Math.abs(pose.y - g.y) < l.bar.h / 2;
  const pressAge = frame - PRESS;
  const gDown = pressAge < 0 ? 0 : pressAge < PRESS_FRAMES - 1 ? 1 : pressAge < PRESS_FRAMES ? 0.5 : 0;

  // Result card: unrolls from under the bar and lands on RESULT_LAND.
  const res = frame < RESULT_IN ? -1 : RESULT_EASE(Math.min(1, (frame - RESULT_IN) / RESULT_FRAMES));

  const flash = flashAt(frame);
  const barCentreY = l.bar.y + l.bar.h / 2;
  const mascotLeft = l.mascot.cx - l.mascot.size / 2;
  const look = gazeAt(frame);

  return (
    <AbsoluteFill>
      {/* The picture; during the flash it is over-exposed as a whole. */}
      <AbsoluteFill style={flash > 0 ? { filter: `brightness(${(1 + 1.7 * flash).toFixed(3)})` } : undefined}>
        <Background glow="dual" />
        <AbsoluteFill style={{ background: TINT }} />

        <Camera shots={vert ? SHOTS_V : SHOTS_L}>
          <CornerWordmark l={l} />
          <Headline layout={l} starts={WORD_STARTS} />

          {rule > 0 && (
            <div
              style={{
                position: "absolute",
                left: l.headline.x,
                top: headlineBottom(l) + l.underline.gap,
                width: l.underline.w * rule,
                height: l.underline.h,
                borderRadius: 999,
                background: `linear-gradient(90deg, ${COLORS.green}, ${COLORS.blurple})`,
                boxShadow: `0 0 ${l.underline.h * 3}px ${withAlpha(COLORS.green, 0.4)}`,
              }}
            />
          )}

          {/* A soft blurple pool behind the mascot, so the action column isn't
            a white bar floating in the dark. */}
          {popP > 0 && (
            <div
              style={{
                position: "absolute",
                left: l.mascot.cx - l.mascot.size * 1.6,
                top: l.mascot.top + l.mascot.size * 0.5 - l.mascot.size * 1.25,
                width: l.mascot.size * 3.2,
                height: l.mascot.size * 2.5,
                background: `radial-gradient(50% 50% at 50% 50%, ${withAlpha(COLORS.blurple, 0.2)}, ${withAlpha(COLORS.blurple, 0.07)} 45%, transparent 72%)`,
                opacity: Math.min(1, popP),
              }}
            />
          )}

          {/* The mascot peeks over the bar: it rises from behind it (clipped at
            the bar's centre line, which the bar itself covers), with a tilt. */}
          {popP > 0 && (
            <div
              style={{
                position: "absolute",
                left: mascotLeft,
                top: l.mascot.top,
                width: l.mascot.size,
                height: l.mascot.size,
                clipPath: `inset(-60% -60% ${(l.mascot.top + l.mascot.size - barCentreY).toFixed(1)}px -60%)`,
              }}
            >
              <div
                style={{
                  opacity: Math.min(1, popP * 3),
                  transform: `translateY(${((1 - popP) * l.mascot.size * 0.72).toFixed(2)}px) rotate(${(l.mascot.tilt + (1 - popP) * 12).toFixed(3)}deg) scale(${(0.86 + 0.14 * popP).toFixed(4)})`,
                  transformOrigin: "50% 100%",
                }}
              >
                <GazeMascot size={l.mascot.size} look={look} open={eyeOpen(frame)} />
              </div>
            </div>
          )}

          {barP > 0 && (
            <div
              style={{
                position: "absolute",
                left: l.bar.x,
                top: l.bar.y,
                opacity: barP < 1 ? Math.min(1, barP * 1.6) : undefined,
                transform:
                  barP < 1
                    ? `translateY(${((1 - barP) * l.bar.h * 0.45).toFixed(2)}px) scale(${(0.965 + 0.035 * barP).toFixed(4)})`
                    : undefined,
              }}
            >
              <SearchBar
                geo={l.bar}
                typed={QUERY.slice(0, typedCount)}
                caret={caret}
                gHover={overG ? 1 : 0}
                gDown={gDown}
                gRipple={pressAge >= 0 && pressAge < G_RIPPLE_FRAMES ? pressAge : null}
              />
            </div>
          )}

          {res >= 0 && (
            <div
              style={{
                position: "absolute",
                left: l.result.x,
                top: l.result.y,
                opacity: res < 1 ? Math.min(1, res * 2.5) : undefined,
                transform: res < 1 ? `translateY(${(-(1 - res) * l.result.pad).toFixed(2)}px)` : undefined,
                clipPath:
                  res < 1 ? `inset(0 0 ${((1 - res) * 100).toFixed(2)}% 0 round ${l.result.radius}px)` : undefined,
              }}
            >
              <ResultCard geo={l.result} />
            </div>
          )}

          <Cursor {...pose} opacity={pointerOpacity} variant={vert ? "touch" : "arrow"} />
        </Camera>
      </AbsoluteFill>

      {flash > 0 &&
        (() => {
          const o = flashOrigin(l, width, height);
          const r = Math.max(width, height);
          return (
            <AbsoluteFill
              style={{
                background: `radial-gradient(circle at ${o.x.toFixed(0)}px ${o.y.toFixed(0)}px, #ffffff 0px, rgba(232,237,255,.75) ${(r * 0.2).toFixed(0)}px, rgba(200,210,255,.35) ${(r * 0.8).toFixed(0)}px)`,
                opacity: 0.42 * flash,
                mixBlendMode: "screen",
                pointerEvents: "none",
              }}
            />
          );
        })()}

      {/* The hit: full-length impact on the cut frame (the score's drop is on
          the same frame; DweebPromo's riser peaks into it). */}
      <Sequence from={HIT} durationInFrames={IMPACT_FRAMES} name="impact">
        <Audio src={staticFile(IMPACT)} volume={VOL.impact} />
      </Sequence>
      <Sequence from={MASCOT_POP + 1} durationInFrames={SFX_FRAMES.pop} name="pop:mascot">
        <Audio src={staticFile(sfxVariant("pop", 0))} volume={VOL.pop} />
      </Sequence>
      {KEYS.map((k, i) => (
        <Sequence key={k} from={k} durationInFrames={SFX_FRAMES.tick} name={`tick:${i}`}>
          <Audio src={staticFile(sfxVariant("tick", i))} volume={VOL.tick} />
        </Sequence>
      ))}
      <Sequence from={PRESS} durationInFrames={SFX_FRAMES.click} name="click:G">
        <Audio src={staticFile(sfxVariant("click", 0))} volume={VOL.click} />
      </Sequence>
      {/* The result's chime, in the pause after "today". */}
      <Sequence from={RESULT_IN + 1} durationInFrames={SFX_FRAMES.chime} name="chime:result">
        <Audio src={staticFile(CHIME)} volume={VOL.chime} />
      </Sequence>
    </AbsoluteFill>
  );
};

/** Absolute film frame from which the end card is fully settled (cover stills, posters). */
export const CTA_SETTLED_ABS = CTA_SEQ + SETTLED;
