import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import { COLORS } from "../theme";
import { INTER, JETBRAINS } from "../fonts";
import { Icon, IconName } from "./Icon";

/* ── Motion helpers ──────────────────────────────────────────────────────── */

/** Spring 0→1 starting at `delay` (scene-relative frames). */
export const useSpr = (delay: number, cfg?: { damping?: number; mass?: number; stiffness?: number }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({
    frame: frame - delay,
    fps,
    config: { damping: 16, mass: 0.6, stiffness: 130, ...cfg },
  });
};

/** Rises in with a spring: fade + translate-up + slight scale settle. */
export const Rise: React.FC<{
  delay?: number;
  from?: number;
  scaleFrom?: number;
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ delay = 0, from = 22, scaleFrom = 0.97, style, children }) => {
  const p = useSpr(delay);
  return (
    <div
      style={{
        opacity: p,
        transform: `translateY(${interpolate(p, [0, 1], [from, 0])}px) scale(${interpolate(p, [0, 1], [scaleFrom, 1])})`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

/** Pops in with a bouncier spring (for chips/badges). */
export const Pop: React.FC<{
  delay?: number;
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ delay = 0, style, children }) => {
  const p = useSpr(delay, { damping: 11, stiffness: 170, mass: 0.5 });
  return (
    <div style={{ opacity: Math.min(1, p * 2), transform: `scale(${interpolate(p, [0, 1], [0.5, 1])})`, ...style }}>
      {children}
    </div>
  );
};

/** Deterministic cursor path: eases between waypoints; `press` marks a click. */
export type Waypoint = { f: number; x: number; y: number; press?: boolean };
export const cursorAt = (frame: number, points: Waypoint[]) => {
  // Smootherstep: zero velocity AND acceleration at both ends, so the pointer
  // glides out of and into every waypoint instead of snapping.
  const ease = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  if (frame <= points[0].f) return { x: points[0].x, y: points[0].y, pressed: false };
  const last = points[points.length - 1];
  if (frame >= last.f) return { x: last.x, y: last.y, pressed: !!last.press };
  let i = 0;
  while (i < points.length - 1 && frame > points[i + 1].f) i++;
  const a = points[i];
  const b = points[i + 1];
  const t = ease((frame - a.f) / (b.f - a.f));
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    pressed: !!b.press && frame > b.f - 5,
  };
};

/* ── Text effects ────────────────────────────────────────────────────────── */

/** Typewriter text with a blinking caret while typing. */
export const TypeText: React.FC<{
  text: string;
  start: number;
  cps?: number; // characters per second (at 30fps)
  mono?: boolean;
  caretColor?: string;
  style?: React.CSSProperties;
}> = ({ text, start, cps = 24, mono = false, caretColor = COLORS.green, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const chars = Math.max(0, Math.floor(((frame - start) / fps) * cps));
  const shown = text.slice(0, chars);
  const done = chars >= text.length;
  const caretOn = Math.floor(frame / 16) % 2 === 0;
  return (
    <span style={{ fontFamily: mono ? JETBRAINS : INTER, whiteSpace: "pre-wrap", ...style }}>
      {shown}
      {!done && frame >= start && (
        <span
          style={{
            display: "inline-block",
            width: 2.5,
            height: "1.05em",
            verticalAlign: "-0.15em",
            background: caretOn ? caretColor : "transparent",
            marginLeft: 2,
            borderRadius: 2,
          }}
        />
      )}
    </span>
  );
};

/** Animated integer counter. */
export const CountUp: React.FC<{
  from?: number;
  to: number;
  start: number;
  duration?: number; // frames
  style?: React.CSSProperties;
}> = ({ from = 0, to, start, duration = 40, style }) => {
  const frame = useCurrentFrame();
  const t = interpolate(frame, [start, start + duration], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const eased = 1 - Math.pow(1 - t, 3);
  const v = Math.round(from + (to - from) * eased);
  return <span style={style}>{v.toLocaleString("en-US")}</span>;
};

/* ── UI atoms ────────────────────────────────────────────────────────────── */

export const Chip: React.FC<{
  icon?: IconName;
  color?: string;
  children: React.ReactNode;
  big?: boolean;
}> = ({ icon, color = COLORS.blurple, children, big = false }) => (
  <div
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: big ? 10 : 8,
      background: `${color}1a`,
      border: `1px solid ${color}55`,
      color: COLORS.text,
      fontFamily: INTER,
      fontWeight: 600,
      fontSize: big ? 24 : 19,
      padding: big ? "10px 18px" : "7px 14px",
      borderRadius: 999,
      whiteSpace: "nowrap",
    }}
  >
    {icon && <Icon name={icon} size={big ? 24 : 19} color={color} />}
    {children}
  </div>
);

/** Animated switch. `on` is 0..1 (drive it with a spring/interpolate). */
export const Toggle: React.FC<{ on: number; size?: number }> = ({ on, size = 30 }) => {
  const w = size * 1.8;
  const knob = size - 8;
  const bg = `rgba(${Math.round(78 + (35 - 78) * on)}, ${Math.round(80 + (165 - 80) * on)}, ${Math.round(88 + (89 - 88) * on)}, 1)`;
  return (
    <div
      style={{
        width: w,
        height: size,
        borderRadius: size,
        background: on > 0.5 ? COLORS.greenDeep : bg,
        position: "relative",
        transition: "none",
        boxShadow: on > 0.5 ? `0 0 18px ${COLORS.green}66` : "none",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 4,
          left: 4 + (w - knob - 8) * on,
          width: knob,
          height: knob,
          borderRadius: "50%",
          background: "#fff",
        }}
      />
    </div>
  );
};

/** Two-option segmented control; `sel` 0..1 animates the thumb left→right. */
export const Segmented: React.FC<{
  a: string;
  b: string;
  sel: number;
  width?: number;
}> = ({ a, b, sel, width = 340 }) => (
  <div
    style={{
      width,
      display: "flex",
      position: "relative",
      background: COLORS.bgInput,
      borderRadius: 12,
      padding: 4,
      border: `1px solid ${COLORS.border}`,
      fontFamily: INTER,
    }}
  >
    <div
      style={{
        position: "absolute",
        top: 4,
        bottom: 4,
        left: 4 + (width / 2 - 4) * sel,
        width: width / 2 - 4,
        background: COLORS.bgActive,
        border: `1px solid ${COLORS.borderStrong}`,
        borderRadius: 9,
      }}
    />
    {[a, b].map((label, i) => (
      <div
        key={label}
        style={{
          flex: 1,
          textAlign: "center",
          padding: "9px 0",
          fontSize: 17,
          fontWeight: 700,
          color: (i === 0 ? 1 - sel : sel) > 0.5 ? COLORS.text : COLORS.textSubtle,
          zIndex: 1,
        }}
      >
        {label}
      </div>
    ))}
  </div>
);

/** App-style button (DWEEB shell, not Discord). */
export const AppBtn: React.FC<{
  children: React.ReactNode;
  kind?: "primary" | "secondary" | "success";
  icon?: IconName;
  size?: "sm" | "md";
  glow?: boolean;
}> = ({ children, kind = "secondary", icon, size = "md", glow = false }) => {
  const bg = kind === "primary" ? COLORS.blurple : kind === "success" ? COLORS.greenDeep : COLORS.bgInput;
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        background: bg,
        color: kind === "secondary" ? COLORS.text : "#fff",
        fontFamily: INTER,
        fontWeight: 700,
        fontSize: size === "sm" ? 15 : 17,
        padding: size === "sm" ? "8px 14px" : "11px 20px",
        borderRadius: 10,
        border: kind === "secondary" ? `1px solid ${COLORS.border}` : "none",
        boxShadow: glow ? `0 0 26px ${bg}88` : "none",
        whiteSpace: "nowrap",
      }}
    >
      {icon && <Icon name={icon} size={size === "sm" ? 16 : 19} color="currentColor" />}
      {children}
    </div>
  );
};

/** Simple colored avatar circle with an initial (for fictional members). */
export const AvatarDot: React.FC<{
  name: string;
  color: string;
  size?: number;
  ring?: string; // presence ring color
}> = ({ name, color, size = 40, ring }) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: "50%",
      background: `linear-gradient(135deg, ${color}, ${color}bb)`,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      color: "#fff",
      fontFamily: INTER,
      fontWeight: 800,
      fontSize: size * 0.42,
      flexShrink: 0,
      boxShadow: ring ? `0 0 0 3px ${COLORS.bg}, 0 0 0 6px ${ring}` : "none",
    }}
  >
    {name[0]}
  </div>
);

/** Deterministic confetti burst around a point (no randomness at render). */
export const Confetti: React.FC<{
  x: number;
  y: number;
  start: number;
  count?: number;
  colors?: string[];
}> = ({ x, y, start, count = 26, colors = [COLORS.green, COLORS.blurple, "#f0b232", "#00a8fc", "#eb459e"] }) => {
  const frame = useCurrentFrame();
  const t = frame - start;
  if (t < 0 || t > 55) return null;
  const items = new Array(count).fill(0).map((_, i) => {
    const angle = (i / count) * Math.PI * 2 + (i % 3) * 0.35;
    const speed = 5.5 + ((i * 37) % 17) * 0.5;
    const px = x + Math.cos(angle) * speed * t * (1 - t / 130);
    const py = y + Math.sin(angle) * speed * t * (1 - t / 130) + 0.14 * t * t;
    const rot = t * (10 + (i % 7) * 4) * (i % 2 ? 1 : -1);
    const o = interpolate(t, [0, 8, 40, 55], [0, 1, 1, 0]);
    return { px, py, rot, o, c: colors[i % colors.length], w: 7 + (i % 3) * 3 };
  });
  return (
    <>
      {items.map((p, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: p.px,
            top: p.py,
            width: p.w,
            height: p.w * 0.62,
            background: p.c,
            opacity: p.o,
            borderRadius: 2,
            transform: `rotate(${p.rot}deg)`,
            zIndex: 25,
          }}
        />
      ))}
    </>
  );
};

/** A soft radial spotlight that pulses once — draws the eye to a point. */
export const PulseRing: React.FC<{ x: number; y: number; start: number; color?: string }> = ({
  x,
  y,
  start,
  color = COLORS.green,
}) => {
  const frame = useCurrentFrame();
  const t = frame - start;
  if (t < 0 || t > 34) return null;
  const r = interpolate(t, [0, 34], [16, 92]);
  const o = interpolate(t, [0, 6, 34], [0, 0.85, 0]);
  return (
    <div
      style={{
        position: "absolute",
        left: x - r,
        top: y - r,
        width: r * 2,
        height: r * 2,
        borderRadius: "50%",
        border: `3px solid ${color}`,
        opacity: o,
        zIndex: 24,
      }}
    />
  );
};
