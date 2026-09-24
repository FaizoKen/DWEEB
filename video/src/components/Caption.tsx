import React from "react";
import { spring } from "remotion";
import { COLORS } from "../theme";
import { INTER } from "../fonts";
import { mixColor, withAlpha } from "../lib/color";
import { settle } from "./Bits";

/* ── Cue data ────────────────────────────────────────────────────────────── */

/**
 * One piece of a caption body. `hl` parts take the accent colour; `at` (an
 * ABSOLUTE film frame) makes the part rise in later than the plate — e.g. the
 * second half of a line landing on the VO word it pays off. Parts that have
 * not risen yet still hold their space, so the plate never resizes.
 */
export type CaptionPart = string | { text: string; hl?: boolean; at?: number };

export type CaptionAspect = "both" | "landscape" | "vertical";

/**
 * An editorial super: a kicker naming the feature and a short body naming the
 * benefit. Frames are ABSOLUTE film frames, so a cue may span a cut — the
 * caption track is rendered once, outside every scene transition.
 */
export type CaptionCue = {
  /** Stable id (diagnostics, React key). */
  id: string;
  /** Kicker (the feature); rendered uppercase. */
  label: string;
  parts: CaptionPart[];
  /** Film frame the plate starts entering. */
  from: number;
  /** Film frame the plate is fully gone; its exit fade ends here. */
  to: number;
  accent: string;
  /** Restrict to one master (default: both). */
  aspect?: CaptionAspect;
};

/* ── Timing ──────────────────────────────────────────────────────────────── */

/** Frames the exit fade takes; it ends at `to`. */
export const CAPTION_EXIT_FRAMES = 12;
/** Default part stagger: part i rises at from + PART_DELAY + i·PART_STAGGER. */
export const CAPTION_PART_DELAY = 5;
export const CAPTION_PART_STAGGER = 3;

const PLATE_SPRING = { damping: 24, mass: 0.72, stiffness: 145 };
const PART_SPRING = { damping: 22, mass: 0.55, stiffness: 160 };

/** Absolute frame a part rises in. */
export const partAt = (cue: CaptionCue, i: number): number => {
  const part = cue.parts[i];
  return typeof part !== "string" && part.at !== undefined
    ? part.at
    : cue.from + CAPTION_PART_DELAY + i * CAPTION_PART_STAGGER;
};

export const partText = (part: CaptionPart): string => (typeof part === "string" ? part : part.text);

export const showsOn = (cue: CaptionCue, vertical: boolean) =>
  !cue.aspect || cue.aspect === "both" || cue.aspect === (vertical ? "vertical" : "landscape");

/* ── Joins ───────────────────────────────────────────────────────────────── */

/**
 * Two cues on the same master that touch — the next starts within
 * JOIN_MAX_GAP frames of the previous one's end, or overlaps it by up to
 * JOIN_MAX_OVERLAP — share ONE plate. Faded out and sprung back in, the plate
 * would vanish for a frame and pop straight back (a blink); joined, it stays
 * put while its text crossfades and its width, height, accent and kicker
 * morph from one cue to the next. A wider gap stays two plates: that reads as
 * a deliberate out-then-in (e.g. the send supers around the landing).
 */
export const JOIN_MAX_GAP = 2;
export const JOIN_MAX_OVERLAP = 8;
/** Each cue's text takes this long to fade out / in… */
export const JOIN_TEXT_FADE = 9;
/** …and the two fades overlap by this much, centred on the seam: a crossfade, never an empty plate. */
export const JOIN_TEXT_OVERLAP = 4;
/** Frames the plate's size and accent take to morph… */
export const JOIN_MORPH_FRAMES = 12;
/**
 * …shifted off the seam by this much: a growing plate opens up AHEAD of the
 * wider text coming in, a shrinking one waits for the wider text going out to
 * fade — so the moving edge never cuts through legible words.
 */
export const JOIN_MORPH_SHIFT = 4;

export type CaptionJoin = {
  a: CaptionCue;
  b: CaptionCue;
  /** The joined plate draws [start, end); lone plates take over on either side. */
  start: number;
  end: number;
  /** A's text fades out over [aOut[0], aOut[1]], B's in over [bIn[0], bIn[1]]. */
  aOut: [number, number];
  bIn: [number, number];
  /** The plate's size, stripe and kicker colour morph over one of these (see JOIN_MORPH_SHIFT). */
  morph: { grow: [number, number]; shrink: [number, number] };
};

/** The joins among the cues shown on one master, in play order. */
export function captionJoins(cues: ReadonlyArray<CaptionCue>, vertical: boolean): CaptionJoin[] {
  const list = cues.filter((c) => showsOn(c, vertical)).sort((x, y) => x.from - y.from);
  const out: CaptionJoin[] = [];
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1];
    const b = list[i];
    const gap = b.from - a.to;
    if (gap > JOIN_MAX_GAP || gap < -JOIN_MAX_OVERLAP) continue;
    const seam = (a.to + b.from) / 2;
    const half = JOIN_TEXT_OVERLAP / 2;
    const aOut: [number, number] = [seam - JOIN_TEXT_FADE + half, seam + half];
    const bIn: [number, number] = [seam - half, seam + JOIN_TEXT_FADE - half];
    const around = (shift: number): [number, number] => [
      seam + shift - JOIN_MORPH_FRAMES / 2,
      seam + shift + JOIN_MORPH_FRAMES / 2,
    ];
    const morph = { grow: around(-JOIN_MORPH_SHIFT), shrink: around(JOIN_MORPH_SHIFT) };
    // Take over from A's lone plate before anything of it moves (its exit fade
    // included), and hand B's lone plate a settled frame: text in, morph done.
    const start = Math.min(a.to - CAPTION_EXIT_FRAMES, Math.floor(aOut[0]), Math.floor(morph.grow[0]));
    const end = Math.ceil(Math.max(bIn[1], morph.shrink[1]));
    // Each cue must still have its own lone frames on either side of the seam.
    if (start <= a.from || end >= b.to) continue;
    out.push({ a, b, start, end, aOut, bIn, morph });
  }
  return out;
}

/* ── Layout ──────────────────────────────────────────────────────────────── */

/**
 * Where captions live on each master, in canvas px. Landscape: bottom-left,
 * the plate's bottom edge 96 px above the frame (clear of the web player's
 * control strip). Vertical: a band from y 236 (below the player's sound pill
 * and close button, which reach y ≈ 213 on small phones), one line preferred.
 */
export const CAPTION_LAYOUT = {
  landscape: {
    left: 96,
    bottom: 96,
    maxWidth: 1180,
    kicker: 22,
    body: 44,
    padding: "18px 30px 21px 32px",
    radius: 16,
    stripe: 6,
    gap: 10,
    columnGap: 11,
  },
  vertical: {
    left: 44,
    right: 44,
    top: 236,
    maxWidth: 992,
    kicker: 30,
    body: 50,
    padding: "21px 30px 24px 34px",
    radius: 20,
    stripe: 7,
    gap: 12,
    columnGap: 13,
  },
} as const;

const BODY_LINE_HEIGHT = 1.12;

const layoutOf = (vertical: boolean) => (vertical ? CAPTION_LAYOUT.vertical : CAPTION_LAYOUT.landscape);
/** The plate's padding as [top, right, bottom, left] px. */
const paddingOf = (vertical: boolean) => layoutOf(vertical).padding.split(" ").map((v) => parseFloat(v));
/** The plate's hairline border (px), inside its box-sizing. */
const PLATE_BORDER = 1;

/* ── The plate ───────────────────────────────────────────────────────────── */

const smooth = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

/** Where a plate sits on its master: bottom-left (landscape) or the top band (vertical). */
const PlateFrame: React.FC<{ vertical: boolean; style?: React.CSSProperties; children: React.ReactNode }> = ({
  vertical,
  style,
  children,
}) => (
  <div
    style={{
      position: "absolute",
      ...(vertical
        ? { top: CAPTION_LAYOUT.vertical.top, left: CAPTION_LAYOUT.vertical.left, right: CAPTION_LAYOUT.vertical.right }
        : { bottom: CAPTION_LAYOUT.landscape.bottom, left: CAPTION_LAYOUT.landscape.left }),
      display: "flex",
      justifyContent: "flex-start",
      ...style,
    }}
  >
    {children}
  </div>
);

/**
 * The opaque plate with its accent stripe. It sizes to its text; `size` pins
 * its border box instead (a joined plate morphing between two cues' sizes).
 */
const PlateBox = React.forwardRef<
  HTMLDivElement,
  { vertical: boolean; accent: string; size?: PlateSize; children: React.ReactNode }
>(({ vertical, accent, size, children }, ref) => {
  const L = layoutOf(vertical);
  return (
    <div
      ref={ref}
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: L.gap,
        maxWidth: L.maxWidth,
        ...(size ? { width: size.w, height: size.h } : {}),
        boxSizing: "border-box",
        padding: L.padding,
        borderRadius: L.radius,
        background: "rgba(10,11,16,.96)",
        border: `${PLATE_BORDER}px solid ${withAlpha(COLORS.borderStrong, 0xaa / 255)}`,
        boxShadow: "0 22px 70px rgba(0,0,0,.5), inset 0 1px rgba(255,255,255,.04)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          bottom: 0,
          width: L.stripe,
          background: accent,
          boxShadow: `0 0 22px ${withAlpha(accent, 0x88 / 255)}`,
        }}
      />
      {children}
    </div>
  );
});
PlateBox.displayName = "PlateBox";

/**
 * A cue's kicker and body at `frame`, parts rising on their own beats (parts
 * not risen yet keep their space). `settled` draws every part at rest — for
 * measuring, where only the layout matters.
 */
const PlateText: React.FC<{ cue: CaptionCue; frame: number; fps: number; vertical: boolean; settled?: boolean }> = ({
  cue,
  frame,
  fps,
  vertical,
  settled = false,
}) => {
  const L = layoutOf(vertical);
  return (
    <>
      <div
        style={{
          fontFamily: INTER,
          fontSize: L.kicker,
          lineHeight: 1,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          fontWeight: 800,
          color: cue.accent,
        }}
      >
        {cue.label}
      </div>
      <div
        style={{
          fontFamily: INTER,
          fontWeight: 800,
          fontSize: L.body,
          lineHeight: BODY_LINE_HEIGHT,
          letterSpacing: "-0.025em",
          color: COLORS.text,
          display: "flex",
          flexWrap: "wrap",
          columnGap: L.columnGap,
          rowGap: 2,
        }}
      >
        {cue.parts.map((part, i) => {
          const p = settled ? 1 : settle(spring({ frame: frame - partAt(cue, i), fps, config: PART_SPRING }));
          const hl = typeof part !== "string" && part.hl;
          const rise = (1 - p) * 10;
          return (
            <span
              key={i}
              style={{
                display: "inline-block",
                opacity: p < 1 ? p : undefined,
                transform: rise > 0.01 ? `translateY(${rise.toFixed(2)}px)` : undefined,
                color: hl ? cue.accent : undefined,
                fontWeight: hl ? 900 : undefined,
                textShadow: hl ? `0 0 26px ${withAlpha(cue.accent, 0x44 / 255)}` : undefined,
              }}
            >
              {partText(part)}
            </span>
          );
        })}
      </div>
    </>
  );
};

/**
 * One cue drawn at film frame `frame`: an opaque plate with an accent stripe
 * that springs in (from below in landscape, from above in the top band in
 * vertical), parts rising in on their own beats, and a clean fade-out that
 * ends exactly at `to`. Returns null outside [from, to). `enter: false` skips
 * the spring — the cue took over a plate already on screen (a join).
 */
export const CaptionPlate: React.FC<{ cue: CaptionCue; frame: number; vertical: boolean; fps: number; enter?: boolean }> = ({
  cue,
  frame,
  vertical,
  fps,
  enter: springsIn = true,
}) => {
  if (frame < cue.from || frame >= cue.to) return null;
  const dir = vertical ? -1 : 1;

  const enter = springsIn ? settle(spring({ frame: frame - cue.from, fps, config: PLATE_SPRING })) : 1;
  const exit = smooth(clamp01((cue.to - frame) / CAPTION_EXIT_FRAMES));
  const opacity = enter * exit;
  if (opacity <= 0.001) return null;
  const shift = (1 - enter) * 26 * dir + (1 - exit) * 8 * dir;

  return (
    <PlateFrame
      vertical={vertical}
      style={{
        opacity: opacity < 1 ? opacity : undefined,
        transform: Math.abs(shift) > 0.01 ? `translateY(${shift.toFixed(2)}px)` : undefined,
      }}
    >
      <PlateBox vertical={vertical} accent={cue.accent}>
        <PlateText cue={cue} frame={frame} fps={fps} vertical={vertical} />
      </PlateBox>
    </PlateFrame>
  );
};

/** A plate's border-box size in px (see PlateMeasurer). */
export type PlateSize = { w: number; h: number };

/**
 * Two touching cues on one plate, for frames in [join.start, join.end): the
 * plate stays put while A's text crossfades into B's around the seam and the
 * plate's size, stripe and kicker colour morph from A's to B's. `sizes` are
 * the two cues' natural plate sizes, so the morph starts and ends exactly on
 * the lone plates on either side.
 */
export const JoinedPlate: React.FC<{
  join: CaptionJoin;
  frame: number;
  vertical: boolean;
  fps: number;
  sizes: Record<string, PlateSize>;
}> = ({ join, frame, vertical, fps, sizes }) => {
  const { a, b } = join;
  const sa = sizes[a.id];
  const sb = sizes[b.id];
  const over = ([from, to]: [number, number]) => smooth(clamp01((frame - from) / (to - from)));
  const m = over(sb.w >= sa.w ? join.morph.grow : join.morph.shrink);
  const size = { w: sa.w + (sb.w - sa.w) * m, h: sa.h + (sb.h - sa.h) * m };
  const aText = 1 - over(join.aOut);
  const bText = over(join.bIn);
  const [pt, pr, , pl] = paddingOf(vertical);
  const L = layoutOf(vertical);
  // Each cue's text keeps its own content width, so it wraps exactly as on its lone plate.
  const layer = (cue: CaptionCue, s: PlateSize, opacity: number) =>
    opacity > 0.001 ? (
      <div
        style={{
          position: "absolute",
          left: pl,
          top: pt,
          width: s.w - pl - pr - 2 * PLATE_BORDER,
          display: "flex",
          flexDirection: "column",
          gap: L.gap,
          opacity: opacity < 1 ? opacity : undefined,
        }}
      >
        <PlateText cue={cue} frame={frame} fps={fps} vertical={vertical} />
      </div>
    ) : null;
  return (
    <PlateFrame vertical={vertical}>
      <PlateBox vertical={vertical} accent={mixColor(a.accent, b.accent, m)} size={size}>
        {layer(a, sa, aText)}
        {layer(b, sb, bText)}
      </PlateBox>
    </PlateFrame>
  );
};

/**
 * Invisible lone plates for `cues`, laid out exactly where they render. Once
 * the fonts are in (`fontsReady` — the fallback font would measure wrong), it
 * reports each plate's border-box size. The caller holds a delayRender until
 * then, so no rendered frame ever uses a guess.
 */
export const PlateMeasurer: React.FC<{
  cues: ReadonlyArray<CaptionCue>;
  vertical: boolean;
  fontsReady: Promise<void>;
  onMeasured: (sizes: Record<string, PlateSize>) => void;
}> = ({ cues, vertical, fontsReady, onMeasured }) => {
  const boxes = React.useRef(new Map<string, HTMLDivElement>());
  React.useLayoutEffect(() => {
    let live = true;
    fontsReady.then(() => {
      if (!live) return;
      const out: Record<string, PlateSize> = {};
      for (const cue of cues) {
        const el = boxes.current.get(cue.id);
        if (!el) continue;
        // The client rect keeps the sub-pixel size; dividing by its ratio to the
        // (transform-proof) layout size undoes a scaled preview in the Studio.
        const r = el.getBoundingClientRect();
        const k = el.offsetWidth > 0 && r.width > 0 ? r.width / el.offsetWidth : 1;
        const scale = Math.abs(k - 1) > 0.02 ? k : 1;
        out[cue.id] = { w: r.width / scale, h: r.height / scale };
      }
      onMeasured(out);
    });
    return () => {
      live = false;
    };
    // All stable (memoised cues, a module promise, a state setter): this runs
    // once per page, and the track unmounts the measurer once it has reported.
  }, [cues, fontsReady, onMeasured]);
  return (
    <>
      {cues.map((cue) => (
        <PlateFrame key={cue.id} vertical={vertical} style={{ visibility: "hidden" }}>
          <PlateBox
            vertical={vertical}
            accent={cue.accent}
            ref={(el) => {
              if (el) boxes.current.set(cue.id, el);
              else boxes.current.delete(cue.id);
            }}
          >
            <PlateText cue={cue} frame={0} fps={30} vertical={vertical} settled />
          </PlateBox>
        </PlateFrame>
      ))}
    </>
  );
};
