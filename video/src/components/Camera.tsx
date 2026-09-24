import React, { createContext, useContext, useId } from "react";
import { AbsoluteFill, Easing, useCurrentFrame, useVideoConfig } from "remotion";

/**
 * A virtual camera that lives in world space. Scenes lay their content out as a
 * normal full-frame (1920×1080) composition; the camera then pushes in, pans and
 * reframes *within* that frame to focus the viewer on whatever is being narrated.
 *
 * A keyframe describes the world point the camera should center `{x, y}` and how
 * far it is zoomed `s`. Product UI defaults to a locked, crisp camera; brand
 * scenes opt into subtle drift explicitly. This keeps small text stable and makes
 * every move feel editorial rather than handheld.
 */
export type Shot = {
  /** Scene-relative frame at which this keyframe is reached. */
  f: number;
  /** World point to center (defaults to frame center 960/540). */
  x?: number;
  y?: number;
  /** Zoom (1 = whole frame visible). */
  s?: number;
  /** Easing into this keyframe from the previous one (default DEFAULT_EASE). */
  ease?: (t: number) => number;
};

/**
 * The world every scene lays out in — a fixed landscape stage, regardless of
 * the canvas aspect. The vertical (9:16) composition films the SAME
 * 1920×1080 world through a taller viewport, so every world coordinate
 * (camera shots, cursor waypoints, overlay positions) is valid in both
 * orientations; only the per-scene shot lists differ.
 */
export const WORLD_W = 1920;
export const WORLD_H = 1080;

/** True when rendering the portrait (9:16) composition. */
export const useVertical = (): boolean => {
  const { width, height } = useVideoConfig();
  return height > width;
};

/* ── Film clock ──────────────────────────────────────────────────────────── */

const SceneStartContext = createContext(0);

/**
 * Tells everything inside a scene where the scene's <Sequence> starts on the
 * film timeline. DweebPromo wraps every scene in one (and SceneProbe does the
 * same when it renders a scene alone), so ambient motion can run on film time.
 */
export const SceneClock: React.FC<{ from: number; children: React.ReactNode }> = ({ from, children }) => (
  <SceneStartContext.Provider value={from}>{children}</SceneStartContext.Provider>
);

/**
 * The absolute film frame, continuous across scene boundaries. Use it (at a
 * scene's top level) for ambient motion — background drift, dust, handheld
 * breathing — which must not jump at a hold cut: scene-local frames restart at
 * every cut, so two scenes showing "the same" background would disagree.
 */
export const useFilmFrame = (): number => useCurrentFrame() + useContext(SceneStartContext);

/* ── Easing ──────────────────────────────────────────────────────────────── */

/**
 * Gentle S-curve for every camera move. Its peak speed is 2.3× the average
 * (v5's bezier(.45,0,.15,1) peaked at 3.1×), so long moves glide instead of
 * bursting, while the settle stays long enough to land softly.
 */
export const DEFAULT_EASE = Easing.bezier(0.25, 0, 0.25, 1);

/**
 * Opt-in punch for impacts (the CTA recoil after the hard cut): fastest on the
 * very first frame, then a long settle. An S-curve would barely move on the
 * frames right after a hit, which reads as sluggish rather than as a recoil.
 */
export const RECOIL_EASE = Easing.bezier(0.16, 1, 0.3, 1);

/* ── Shot sampling and on-screen velocity ────────────────────────────────── */

export type CameraState = { x: number; y: number; s: number };

const validated = new WeakSet<Shot[]>();
const assertSorted = (shots: Shot[]) => {
  if (validated.has(shots)) return;
  if (shots.length === 0) throw new Error("Camera: shots must contain at least one keyframe");
  for (let i = 1; i < shots.length; i++) {
    if (!(shots[i].f > shots[i - 1].f)) {
      throw new Error(
        `Camera: keyframes must be strictly increasing in f, but shots[${i - 1}].f = ${shots[i - 1].f} ` +
          `and shots[${i}].f = ${shots[i].f}. A timing change (e.g. a re-recorded VO line) probably ` +
          "reordered them — re-anchor the shot list.",
      );
    }
  }
  validated.add(shots);
};

/** The camera's world centre and zoom at a (scene-local) frame. */
export function sampleShots(shots: Shot[], frame: number): CameraState {
  assertSorted(shots);
  const cx = (k: Shot) => k.x ?? 960;
  const cy = (k: Shot) => k.y ?? 540;
  const cs = (k: Shot) => k.s ?? 1;

  if (frame <= shots[0].f) return { x: cx(shots[0]), y: cy(shots[0]), s: cs(shots[0]) };
  const last = shots[shots.length - 1];
  if (frame >= last.f) return { x: cx(last), y: cy(last), s: cs(last) };

  let i = 0;
  while (i < shots.length - 1 && frame > shots[i + 1].f) i++;
  const a = shots[i];
  const b = shots[i + 1];
  const ease = b.ease ?? DEFAULT_EASE;
  const t = ease(Math.max(0, Math.min(1, (frame - a.f) / (b.f - a.f))));
  return {
    x: cx(a) + (cx(b) - cx(a)) * t,
    y: cy(a) + (cy(b) - cy(a)) * t,
    s: cs(a) + (cs(b) - cs(a)) * t,
  };
}

/**
 * How fast the filmed CONTENT moves on the canvas between `frame − 1` and
 * `frame`, in canvas px/frame per axis. A world point at screen offset u from
 * the centre moves by u·(1 − s₀/s₁) − Δx·s₀: the pan term is exact, and the
 * zoom term is taken at u = W/4 (H/4), the mean distance of on-screen content
 * from the centre along that axis. (v5 measured the world ORIGIN instead, which
 * is nowhere near the frame once the camera pans, so its blur tracked nothing.)
 * Exported so shot lists can be linted against the ~25 px/frame text limit.
 */
export function screenVelocity(
  shots: Shot[],
  frame: number,
  canvas: { width: number; height: number },
): { vx: number; vy: number; speed: number } {
  const b = sampleShots(shots, frame);
  const a = sampleShots(shots, frame - 1);
  const zoom = Math.abs(1 - a.s / b.s);
  const vx = Math.abs((b.x - a.x) * a.s) + (canvas.width / 4) * zoom;
  const vy = Math.abs((b.y - a.y) * a.s) + (canvas.height / 4) * zoom;
  return { vx, vy, speed: Math.hypot(vx, vy) };
}

/** Content speed (canvas px/frame) below which a frame stays perfectly crisp. */
const BLUR_THRESHOLD = 18;
/** Blur σ (canvas px) added per px/frame above the threshold, at multiplier 1. */
const BLUR_PER_SPEED = 0.06;
/** Blur never exceeds this σ (canvas px), whatever the speed or multiplier. */
export const MAX_BLUR = 3;
/** Below this σ the filter is dropped entirely (static frames carry no filter). */
const MIN_BLUR = 0.15;

export const Camera: React.FC<{
  shots: Shot[];
  /** Handheld drift amplitude in world px (0 to disable). Runs on film time. */
  drift?: number;
  /**
   * Motion-blur strength multiplier (default 1; 0 disables). Blur follows the
   * real on-screen content velocity: none at or below 18 px/frame, then
   * 0.06 px of σ per px/frame × this multiplier, capped at 3 canvas px. It is
   * directional — smeared along the motion, so text stays readable across it.
   */
  blur?: number;
  children: React.ReactNode;
}> = ({ shots, drift = 0, blur = 1, children }) => {
  const frame = useCurrentFrame();
  const filmFrame = useFilmFrame();
  const { width: W, height: H } = useVideoConfig();
  const filterId = `camera-blur-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const here = sampleShots(shots, frame);

  // Perpetual handheld breathing on FILM time, so two scenes framing the same
  // shot across a cut breathe in register — tiny, organic, never distracting.
  const dx = drift ? Math.sin(filmFrame / 57) * drift + Math.sin(filmFrame / 23) * drift * 0.3 : 0;
  const dy = drift ? Math.cos(filmFrame / 71) * drift + Math.cos(filmFrame / 31) * drift * 0.3 : 0;

  const s = here.s;
  const tx = W / 2 - (here.x + dx) * s;
  const ty = H / 2 - (here.y + dy) * s;

  let sx = 0;
  let sy = 0;
  if (blur > 0) {
    const v = screenVelocity(shots, frame, { width: W, height: H });
    const sigma = Math.min(MAX_BLUR, Math.max(0, (v.speed - BLUR_THRESHOLD) * BLUR_PER_SPEED * blur));
    if (sigma >= MIN_BLUR) {
      sx = (sigma * v.vx) / v.speed;
      sy = (sigma * v.vy) / v.speed;
    }
  }
  const blurring = sx >= MIN_BLUR || sy >= MIN_BLUR;

  // The blur sits on an UNSCALED wrapper so its σ is in canvas pixels — on the
  // scaled world layer it would be multiplied by the zoom (v5's 4 px cap
  // rendered as ~7 px at s = 1.6). No will-change: each frame is rendered from
  // scratch, and a promoted layer only risks a stale raster scale after zooms.
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      {blurring && (
        <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden>
          <filter id={filterId} x="-10%" y="-10%" width="120%" height="120%" colorInterpolationFilters="sRGB">
            <feGaussianBlur stdDeviation={`${sx.toFixed(2)} ${sy.toFixed(2)}`} />
          </filter>
        </svg>
      )}
      <AbsoluteFill style={blurring ? { filter: `url(#${filterId})` } : undefined}>
        <div
          style={{
            position: "absolute",
            width: WORLD_W,
            height: WORLD_H,
            transformOrigin: "0 0",
            transform: `translate(${tx}px, ${ty}px) scale(${s})`,
          }}
        >
          {children}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
