import React from "react";
import { COLORS } from "../theme";
import { INTER } from "../fonts";
import { withAlpha } from "../lib/color";

/* ── Timing ──────────────────────────────────────────────────────────────── */

/** A press holds the button down on [f, f + PRESS_FRAMES): the CLICK SFX plays at f. */
export const PRESS_FRAMES = 4;
/** The click ripple expands from the tip over [f, f + RIPPLE_FRAMES). */
export const RIPPLE_FRAMES = 10;

/**
 * A pointer keyframe (scene-local frame, world coordinates of the TIP).
 * `press: true` means the button goes down exactly at `f` — the frame the
 * CLICK sound plays — and the pointer then stays on the target for
 * PRESS_FRAMES before any move to the next waypoint begins.
 */
export type Waypoint = { f: number; x: number; y: number; press?: boolean };

export type CursorPose = {
  x: number;
  y: number;
  /** True during the press window [f, f + PRESS_FRAMES) of the latest press. */
  pressed: boolean;
  /** Frames since the latest press while its ripple is still running, else null. */
  pressAge: number | null;
};

// Smootherstep: zero velocity AND acceleration at both ends, so the pointer
// glides out of and into every waypoint instead of snapping.
const glide = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

const validated = new WeakSet<Waypoint[]>();
const assertValid = (points: Waypoint[]) => {
  if (validated.has(points)) return;
  if (points.length === 0) throw new Error("cursorAt: waypoints must not be empty");
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (!(b.f > a.f)) {
      throw new Error(
        `cursorAt: waypoints must be strictly increasing in f, but #${i - 1} is at f=${a.f} and #${i} at f=${b.f} ` +
          "(an out-of-order list makes the pointer teleport). Re-anchor them.",
      );
    }
    const moves = a.x !== b.x || a.y !== b.y;
    if (a.press && moves && b.f <= a.f + PRESS_FRAMES) {
      throw new Error(
        `cursorAt: the press at f=${a.f} is followed by a move at f=${b.f}; the pointer must stay on its ` +
          `target while the button is down, so the next move can end no earlier than f=${a.f + PRESS_FRAMES + 1}.`,
      );
    }
  }
  validated.add(points);
};

/**
 * Where the pointer is at `frame`, and whether/how long ago it clicked.
 * Throws on unsorted waypoints or a move that starts while the button is down.
 */
export function cursorAt(frame: number, points: Waypoint[]): CursorPose {
  assertValid(points);

  let latestPress: number | null = null;
  for (const p of points) if (p.press && p.f <= frame) latestPress = p.f;
  const age = latestPress === null ? null : frame - latestPress;
  const pressed = age !== null && age < PRESS_FRAMES;
  const pressAge = age !== null && age < RIPPLE_FRAMES ? age : null;

  const first = points[0];
  if (frame <= first.f) return { x: first.x, y: first.y, pressed, pressAge };
  const last = points[points.length - 1];
  if (frame >= last.f) return { x: last.x, y: last.y, pressed, pressAge };

  let i = 0;
  while (i < points.length - 1 && frame > points[i + 1].f) i++;
  const a = points[i];
  const b = points[i + 1];
  // A move out of a press only starts once the button is released.
  const start = a.press ? a.f + PRESS_FRAMES : a.f;
  const t = glide(Math.max(0, Math.min(1, (frame - start) / (b.f - start))));
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, pressed, pressAge };
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/**
 * Pointer opacity for explicit on-screen windows `[from, to)` (scene-local):
 * it fades in over `fadeIn` frames from `from` and is fully gone at `to`
 * after a `fadeOut`-frame fade — never a one-frame pop in or out.
 */
export function cursorOpacity(
  frame: number,
  windows: ReadonlyArray<readonly [number, number]>,
  { fadeIn = 5, fadeOut = 6 }: { fadeIn?: number; fadeOut?: number } = {},
): number {
  let o = 0;
  for (const [from, to] of windows) {
    if (frame < from || frame >= to) continue;
    const enter = Math.min(1, (frame - from + 1) / fadeIn);
    const exit = Math.min(1, (to - frame) / fadeOut);
    o = Math.max(o, smooth(Math.min(enter, exit)));
  }
  return o;
}

/* ── Drawing ─────────────────────────────────────────────────────────────── */

export type CursorVariant = "arrow" | "touch" | "member" | "member-touch";

/** The arrow's hotspot in its 24-unit viewBox. */
const TIP = { x: 5, y: 3 };
const ARROW_PATH = "M5 3l14 7-6 1.5L9 18z";
/** Default arrow height and touch-dot diameter (world px). The name flag is sized from the arrow. */
const ARROW_SIZE = 32;
const TOUCH_SIZE = 26;

/** Where a touch member's flag hangs off the dot (a finger covers what is below a tap, so "above-*" keeps a tapped label clear). */
export type FlagSide = "below-right" | "above-right" | "below-left" | "above-left";

/** A member's name flag, placed by CSS offsets from the pointer's hotspot (a 0×0 box). */
const NameFlag: React.FC<{ name: string; color: string; base: number; at: React.CSSProperties }> = ({
  name,
  color,
  base,
  at,
}) => (
  <div
    style={{
      position: "absolute",
      ...at,
      padding: `${base * 0.06}px ${base * 0.24}px ${base * 0.08}px`,
      borderRadius: base * 0.2,
      background: color,
      color: "#fff",
      fontFamily: INTER,
      fontSize: base * 0.42,
      fontWeight: 700,
      lineHeight: 1.2,
      whiteSpace: "nowrap",
      boxShadow: "0 4px 12px rgba(0,0,0,.4)",
    }}
  >
    {name}
  </div>
);

/**
 * A pointer whose TIP (or touch centre) sits exactly on (x, y), in world px:
 *
 * - `arrow`  — the OS-style pointer (landscape).
 * - `touch`  — a translucent finger-tip dot (vertical: phones have no arrow).
 * - `member` — an arrow in a member's colour carrying a name flag, for another
 *   person acting in the same space (Kai clicking the giveaway in Discord).
 * - `member-touch` — the same person on a phone: a finger-tip dot and ripple
 *   in the member's colour, with the same name flag hanging off the dot.
 *
 * The press shows at/after the press frame: the pointer dips slightly while
 * the button is down and a ring ripples out from the tip, so the CLICK sound
 * at `f` always coincides with a visible press. Spread a `cursorAt()` pose
 * into it: `<Cursor {...cursorAt(frame, waypoints)} opacity={…} />`.
 */
export const Cursor: React.FC<{
  x: number;
  y: number;
  variant?: CursorVariant;
  /** Frames since the latest press (from cursorAt); drives the dip and the ripple. */
  pressAge?: number | null;
  /** Legacy flag: shows the pressed pose without a ripple when pressAge is absent. */
  pressed?: boolean;
  /** 0–1, e.g. from cursorOpacity(). Nothing renders at 0. */
  opacity?: number;
  /** Arrow height (world px, default 32) or touch-dot diameter (default 26). */
  size?: number;
  /** member / member-touch: name on the flag. */
  name?: string;
  /** member / member-touch: pointer (arrow or dot), flag and ripple colour. */
  color?: string;
  /** member-touch: which side of the dot the flag hangs (default below-right, as the arrow's). */
  flag?: FlagSide;
}> = ({ x, y, variant = "arrow", pressAge, pressed = false, opacity = 1, size, name, color, flag = "below-right" }) => {
  if (opacity <= 0.001) return null;
  const age = pressAge ?? (pressed ? 0 : null);
  const down = age !== null && age < PRESS_FRAMES;
  const member = variant === "member" || variant === "member-touch";
  const touch = variant === "touch" || variant === "member-touch";
  const accent = member ? (color ?? COLORS.blurple) : COLORS.green;

  const dim = size ?? (touch ? TOUCH_SIZE : ARROW_SIZE);
  // Slight dip while the button is down, released by the end of the window.
  const dip = age !== null && age < PRESS_FRAMES ? 0.86 + 0.14 * (age / PRESS_FRAMES) ** 2 : 1;

  const ripple =
    pressAge !== null && pressAge !== undefined
      ? (() => {
          const t = pressAge / RIPPLE_FRAMES;
          const grow = 1 - (1 - t) ** 3;
          const r0 = touch ? dim * 0.5 : dim * 0.16;
          const r1 = touch ? dim * 1.35 : dim * 0.9;
          const r = r0 + (r1 - r0) * grow;
          return (
            <div
              style={{
                position: "absolute",
                left: -r,
                top: -r,
                width: r * 2,
                height: r * 2,
                boxSizing: "border-box",
                borderRadius: "50%",
                border: `${touch ? 3 : 2.5}px solid ${accent}`,
                opacity: 0.85 * (1 - t) ** 1.4,
              }}
            />
          );
        })()
      : null;

  let body: React.ReactNode;
  if (touch) {
    const tinted = variant === "member-touch";
    body = (
      <>
        <div
          style={{
            position: "absolute",
            left: -dim / 2,
            top: -dim / 2,
            width: dim,
            height: dim,
            boxSizing: "border-box",
            borderRadius: "50%",
            background: tinted ? withAlpha(accent, down ? 0.58 : 0.4) : `rgba(255,255,255,${down ? 0.46 : 0.3})`,
            border: tinted ? `2px solid ${accent}` : "2px solid rgba(255,255,255,.8)",
            // The member's dot keeps a hairline of white so it reads on a button of a similar hue.
            boxShadow: tinted ? "0 3px 12px rgba(0,0,0,.4), inset 0 0 0 1px rgba(255,255,255,.6)" : "0 3px 12px rgba(0,0,0,.4)",
            transform: dip !== 1 ? `scale(${dip * 0.95})` : undefined,
          }}
        />
        {/* Flag sized like the member arrow's, its corner tucked on the dot's edge. */}
        {tinted && name && (
          <NameFlag
            name={name}
            color={accent}
            base={dim * (ARROW_SIZE / TOUCH_SIZE)}
            at={{
              [flag.endsWith("left") ? "right" : "left"]: dim * 0.36,
              [flag.startsWith("above") ? "bottom" : "top"]: dim * 0.3,
            }}
          />
        )}
      </>
    );
  } else {
    const tipX = (TIP.x / 24) * dim;
    const tipY = (TIP.y / 24) * dim;
    body = (
      <>
        <div
          style={{
            position: "absolute",
            left: -tipX,
            top: -tipY,
            width: dim,
            height: dim,
            transform: dip !== 1 ? `scale(${dip})` : undefined,
            transformOrigin: `${tipX}px ${tipY}px`,
            filter: "drop-shadow(0 4px 8px rgba(0,0,0,0.55))",
          }}
        >
          <svg width={dim} height={dim} viewBox="0 0 24 24" style={{ display: "block" }}>
            <path
              d={ARROW_PATH}
              fill={member ? accent : "#fff"}
              stroke={member ? "#fff" : "#0b0d12"}
              strokeWidth={member ? 1.4 : 1.2}
              strokeLinejoin="round"
            />
          </svg>
        </div>
        {member && name && <NameFlag name={name} color={accent} base={dim} at={{ left: dim * 0.5, top: dim * 0.6 }} />}
      </>
    );
  }

  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: 0,
        height: 0,
        opacity: opacity < 1 ? opacity : undefined,
        pointerEvents: "none",
        zIndex: 30,
      }}
    >
      {ripple}
      {body}
    </div>
  );
};
