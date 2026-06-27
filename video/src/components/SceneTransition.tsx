import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate, Easing } from "remotion";

export type TransitionType = "dissolve" | "whip" | "push";

export const TRANSITION_FRAMES = 20;

// Soft, gentle ease-in-out. The incoming shot resolves to rest on an S-curve
// rather than a snappy spring, so nothing "pops" or flashes in.
const EASE = Easing.bezier(0.4, 0, 0.2, 1);

/**
 * Entrance transition applied to a scene's first {@link TRANSITION_FRAMES}.
 * Each scene has an opaque background and renders on top of the outgoing one, so
 * an eased fade/scale entrance reads as a smooth cross-dissolve over the previous
 * shot.
 *
 * Everything is intentionally restrained — tiny scale settles, gentle glides and
 * only the faintest motion blur — so cuts feel like the camera easing onto the
 * next subject, never a hard or bright snap.
 *
 * - `dissolve` — a clean cross-fade with a barely-there scale settle.
 * - `push`     — fade plus a small directional glide, for momentum between beats.
 * - `whip`     — a soft directional glide with a hint of blur that clears fast.
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

  // Hold opacity back a touch at the very start so bright incoming content eases
  // up gradually instead of flashing in.
  const opacity = interpolate(e, [0, 0.5, 1], [0, 0.4, 1]);

  let style: React.CSSProperties = { opacity };
  if (type === "dissolve") {
    style = { opacity, transform: `scale(${interpolate(e, [0, 1], [1.015, 1])})` };
  } else if (type === "push") {
    style = {
      opacity,
      transform: `translateX(${(1 - e) * 2.5}%) scale(${interpolate(e, [0, 1], [1.012, 1])})`,
    };
  } else if (type === "whip") {
    // Softened: a gentle glide with only a faint blur that clears almost
    // immediately — no hard slide, no heavy motion blur.
    const blur = interpolate(e, [0, 0.5, 1], [3, 1, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
    style = {
      opacity,
      transform: `translateX(${(1 - e) * 5}%) scale(${interpolate(e, [0, 1], [1.01, 1])})`,
      filter: blur > 0.25 ? `blur(${blur.toFixed(2)}px)` : undefined,
    };
  }

  return <AbsoluteFill style={style}>{children}</AbsoluteFill>;
};
