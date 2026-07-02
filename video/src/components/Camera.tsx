import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  Easing,
} from "remotion";

/**
 * A virtual camera that lives in world space. Scenes lay their content out as a
 * normal full-frame (1920×1080) composition; the camera then pushes in, pans and
 * reframes *within* that frame to focus the viewer on whatever is being narrated.
 *
 * A keyframe describes the world point the camera should center `{x, y}` and how
 * far it is zoomed `s`. The camera eases between consecutive keyframes, so a list
 * of keyframes reads as a continuous, motivated camera move. A little perpetual
 * handheld drift keeps even "static" shots breathing, and fast moves pick up a
 * touch of motion blur — the two things that separate a real camera from a CSS
 * transform.
 */
export type Shot = {
  /** Scene-relative frame at which this keyframe is reached. */
  f: number;
  /** World point to center (defaults to frame center 960/540). */
  x?: number;
  y?: number;
  /** Zoom (1 = whole frame visible). */
  s?: number;
  /** Easing into this keyframe from the previous one. */
  ease?: (t: number) => number;
};

// Soft S-curve: slow attack, long settle — camera moves never feel like snaps.
const DEFAULT_EASE = Easing.bezier(0.45, 0, 0.15, 1);

function sample(shots: Shot[], frame: number) {
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
  const raw = (frame - a.f) / (b.f - a.f);
  const t = ease(Math.max(0, Math.min(1, raw)));
  return {
    x: cx(a) + (cx(b) - cx(a)) * t,
    y: cy(a) + (cy(b) - cy(a)) * t,
    s: cs(a) + (cs(b) - cs(a)) * t,
  };
}

export const Camera: React.FC<{
  shots: Shot[];
  /** Handheld drift amplitude in world px (0 to disable). */
  drift?: number;
  /**
   * Added to the frame that drives the drift. Pass the scene's absolute start
   * (seqFrom) so the handheld motion is continuous across a matched cut —
   * without it, two scenes framing the same shot drift out of register.
   */
  phase?: number;
  /** Motion-blur strength multiplier (0 to disable). */
  blur?: number;
  children: React.ReactNode;
}> = ({ shots, drift = 5, phase = 0, blur = 1, children }) => {
  const frame = useCurrentFrame();
  const { width: W, height: H } = useVideoConfig();

  const here = sample(shots, frame);
  const prev = sample(shots, frame - 1);

  // Perpetual handheld breathing — tiny, organic, never distracting.
  const df = frame + phase;
  const dx = drift ? Math.sin(df / 57) * drift + Math.sin(df / 23) * drift * 0.3 : 0;
  const dy = drift ? Math.cos(df / 71) * drift + Math.cos(df / 31) * drift * 0.3 : 0;

  const x = here.x + dx;
  const y = here.y + dy;
  const s = here.s;

  const tx = W / 2 - x * s;
  const ty = H / 2 - y * s;

  // Screen-space velocity of the transform → a *subtle* gaussian motion blur on
  // fast pans/zooms only. Gentle push-ins stay perfectly crisp; only quick moves
  // pick up a touch of blur to ease the eye through them.
  const ptx = W / 2 - prev.x * prev.s;
  const pty = H / 2 - prev.y * prev.s;
  const speed = Math.abs(tx - ptx) + Math.abs(ty - pty) + Math.abs(s - prev.s) * 500;
  const blurPx = blur ? Math.min(4, Math.max(0, (speed - 16) * 0.07)) : 0;

  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          width: W,
          height: H,
          transformOrigin: "0 0",
          transform: `translate3d(${tx}px, ${ty}px, 0) scale(${s})`,
          filter: blurPx > 0.15 ? `blur(${blurPx.toFixed(2)}px)` : undefined,
          willChange: "transform",
        }}
      >
        {children}
      </div>
    </AbsoluteFill>
  );
};
