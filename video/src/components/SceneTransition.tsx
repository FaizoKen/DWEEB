import React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";
import { TRANSITION_FRAMES } from "../timeline";
import { STAGE_COLOR } from "../theme";

export { TRANSITION_FRAMES };

/**
 * How a scene enters. Every incoming scene's <Sequence> starts
 * TRANSITION_FRAMES (T) before its cut and plays over the outgoing scene:
 *
 * - `match` — opacity-only crossfade over the T-frame overlap (no scale: any
 *   scale would break the registration the cut depends on). Both scenes must
 *   hold a static camera through the overlap with the shared element — the
 *   message card — pixel-registered, so only what differs actually fades.
 * - `hold`  — an invisible cut on the boundary for identical shared state
 *   (same camera, same components, same props). The incoming layer is not
 *   rendered at all until its cut frame (local T).
 * - `dip`   — DIP_OUT frames fading the outgoing shot to the stage colour,
 *   then DIP_IN frames revealing the incoming one out of it. For a change of
 *   place where a crossfade would double-expose two different messages.
 * - `cut`   — a hard cut at the cut frame (local T), for an impact. Identical
 *   to `hold` on screen; the name records the intent (and it gets no whoosh).
 *
 * Invisible frames render NOTHING (not an opacity-0 copy), and a settled scene
 * gets no wrapper style at all — an identity transform/opacity/filter changes
 * how Chrome layers and rasterizes the content, so two otherwise identical
 * frames on either side of a hold cut would differ by anti-aliasing.
 *
 * AUDIO CAVEAT: because an invisible layer is not mounted, any <Audio> a scene
 * schedules before its first visible frame (local T for hold/cut, DIP_OUT for
 * dip) is dropped or starts late, and a scene's audio also stops at its
 * Sequence's end (the next cut). Key scene SFX at or after the cut; a sound
 * that must start earlier or ring across a cut belongs in the film's SFX
 * track (src/sfxTrack.tsx).
 */
export type TransitionType = "match" | "hold" | "dip" | "cut";

/** Frames the dip spends fading the outgoing shot out to the stage colour. */
export const DIP_OUT = 7;
/** Frames the dip spends revealing the incoming shot (the rest of the overlap). */
export const DIP_IN = TRANSITION_FRAMES - DIP_OUT;
if (DIP_IN < 1) throw new Error(`TRANSITION_FRAMES (${TRANSITION_FRAMES}) must exceed DIP_OUT (${DIP_OUT})`);

const MATCH_EASE = Easing.bezier(0.33, 0, 0.67, 1);
const DIP_OUT_EASE = Easing.bezier(0.4, 0, 1, 1);
const DIP_IN_EASE = Easing.bezier(0, 0, 0.6, 1);

/**
 * Entrance transition for one scene. `type: null` (the opening scene) renders
 * the scene plainly from its first frame.
 */
export const SceneTransition: React.FC<{
  type: TransitionType | null;
  children: React.ReactNode;
}> = ({ type, children }) => {
  const frame = useCurrentFrame();
  const plain = <AbsoluteFill>{children}</AbsoluteFill>;
  if (type === null || frame >= TRANSITION_FRAMES) return plain;

  if (type === "hold" || type === "cut") return null;

  if (type === "match") {
    const opacity = MATCH_EASE(frame / TRANSITION_FRAMES);
    if (opacity <= 0.001) return null;
    return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>;
  }

  // dip: the incoming layer sits above the outgoing scene, so it can darken
  // the outgoing shot on its own before it shows anything of itself.
  if (frame < DIP_OUT) {
    const dark = DIP_OUT_EASE((frame + 1) / DIP_OUT);
    return <AbsoluteFill style={{ backgroundColor: STAGE_COLOR, opacity: dark }} />;
  }
  const dark = 1 - DIP_IN_EASE(interpolate(frame, [DIP_OUT - 1, TRANSITION_FRAMES - 1], [0, 1]));
  if (dark <= 0.001) return plain;
  return (
    <AbsoluteFill>
      {children}
      <AbsoluteFill style={{ backgroundColor: STAGE_COLOR, opacity: dark }} />
    </AbsoluteFill>
  );
};
