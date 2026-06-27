import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate, Easing } from "remotion";

export type TransitionType = "dissolve" | "whip" | "push";

export const TRANSITION_FRAMES = 16;

/**
 * Entrance transition applied to a scene's first {@link TRANSITION_FRAMES}.
 * Each scene has an opaque background and renders on top of the outgoing one, so
 * a fade/scale entrance reads as a real cross-dissolve over the previous shot.
 *
 * - `dissolve` — cross-fade with a gentle scale settle (the default; feels like
 *   the camera easing to rest on the new subject).
 * - `push`     — fade plus a directional glide, for momentum between beats.
 * - `whip`     — a fast horizontal slide with motion blur, for a kinetic cut.
 */
export const SceneTransition: React.FC<{
  type?: TransitionType;
  children: React.ReactNode;
}> = ({ type = "dissolve", children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame, fps, durationInFrames: TRANSITION_FRAMES, config: { damping: 200 } });

  let style: React.CSSProperties = { opacity: p };
  if (type === "dissolve") {
    style = { opacity: p, transform: `scale(${interpolate(p, [0, 1], [1.06, 1])})` };
  } else if (type === "push") {
    const k = interpolate(p, [0, 1], [1, 0], { easing: Easing.out(Easing.cubic) });
    style = { opacity: p, transform: `translateX(${k * 6}%) scale(${interpolate(p, [0, 1], [1.04, 1])})` };
  } else if (type === "whip") {
    const k = interpolate(p, [0, 1], [1, 0]);
    const blur = interpolate(p, [0, 0.5, 1], [11, 5, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    style = {
      opacity: interpolate(p, [0, 0.3, 1], [0, 1, 1]),
      transform: `translateX(${k * 15}%)`,
      filter: blur > 0.2 ? `blur(${blur}px)` : undefined,
    };
  }

  return <AbsoluteFill style={style}>{children}</AbsoluteFill>;
};
