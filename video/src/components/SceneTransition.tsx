import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate, Easing } from "remotion";
import { TRANSITION_FRAMES } from "../timeline";

export type TransitionType = "dissolve" | "whip" | "push" | "hold";

export { TRANSITION_FRAMES };

const EASE = Easing.bezier(0.4, 0, 0.2, 1);

/**
 * Entrance transition applied to a scene's first {@link TRANSITION_FRAMES}.
 * Each scene has an opaque background and renders on top of the outgoing one, so
 * an eased fade/scale entrance reads as a smooth cross-dissolve over the previous
 * shot.
 *
 * - `dissolve` — a clean cross-fade with a barely-there scale settle.
 * - `push`     — a fast masked reveal, motivated by moving deeper into the flow.
 * - `whip`     — reserved for a genuine spatial jump.
 * - `hold`     — a true cut on the boundary for identical shared state. Fading
 *                two nearly-identical UIs creates ghosted text, so it is avoided.
 */
export const SceneTransition: React.FC<{
  type?: TransitionType;
  children: React.ReactNode;
}> = ({ type = "dissolve", children }) => {
  const frame = useCurrentFrame();

  // Eased 0→1 progress across the transition window.
  const e = interpolate(frame, [0, TRANSITION_FRAMES], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });

  const opacity = interpolate(e, [0, 0.55, 1], [0, 0.46, 1]);

  let style: React.CSSProperties = { opacity };
  if (type === "hold") {
    style = { opacity: frame < TRANSITION_FRAMES ? 0 : 1 };
  } else if (type === "dissolve") {
    style = { opacity, transform: `scale(${interpolate(e, [0, 1], [1.012, 1])})` };
  } else if (type === "push") {
    style = {
      opacity: 1,
      clipPath: `inset(0 ${(1 - e) * 100}% 0 0)`,
      transform: `translateX(${(1 - e) * 34}px)`,
    };
  } else if (type === "whip") {
    const blur = interpolate(e, [0, 0.55, 1], [7, 1.5, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
    style = {
      opacity,
      transform: `translateX(${(1 - e) * 7}%) scale(${interpolate(e, [0, 1], [1.018, 1])})`,
      filter: blur > 0.25 ? `blur(${blur.toFixed(2)}px)` : undefined,
    };
  }

  return <AbsoluteFill style={style}>{children}</AbsoluteFill>;
};
