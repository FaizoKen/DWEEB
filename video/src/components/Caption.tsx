import React from "react";
import { useCurrentFrame, spring, useVideoConfig, interpolate } from "remotion";
import { COLORS } from "../theme";
import { INTER } from "../fonts";

type Part = string | { hl: string };
type Word = { text: string; hl: boolean };

/**
 * A kinetic lower-third that reinforces the VO. The pill rises in, then the words
 * animate up one-by-one in a quick stagger; highlighted words punch a touch
 * larger with an accent glow. Lives at screen level (outside the Camera) so it
 * stays pin-sharp and readable while the world moves behind it.
 */
export const Caption: React.FC<{
  parts: Part[];
  delay?: number;
  out?: number; // scene-relative frame to start fading out
  accent?: string;
}> = ({ parts, delay = 0, out, accent = COLORS.green }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const words: Word[] = [];
  for (const p of parts) {
    if (typeof p === "string") {
      for (const w of p.split(/(\s+)/)) {
        if (w.trim() === "") continue;
        words.push({ text: w, hl: false });
      }
    } else {
      for (const w of p.hl.split(/(\s+)/)) {
        if (w.trim() === "") continue;
        words.push({ text: w, hl: true });
      }
    }
  }

  const box = spring({ frame: frame - delay, fps, config: { damping: 20, mass: 0.7 } });
  const exit = out
    ? interpolate(frame, [out, out + 12], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
    : 1;
  const opacity = box * exit;
  if (opacity <= 0.001) return null;

  return (
    <div
      style={{
        position: "absolute",
        bottom: 84,
        left: 0,
        right: 0,
        display: "flex",
        justifyContent: "center",
        padding: "0 160px",
        opacity,
        transform: `translateY(${interpolate(box, [0, 1], [40, 0])}px)`,
        zIndex: 40,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 18,
          background: "rgba(10,11,15,0.72)",
          backdropFilter: "blur(10px)",
          WebkitBackdropFilter: "blur(10px)",
          border: `1px solid ${COLORS.border}`,
          borderRadius: 18,
          padding: "16px 30px 16px 26px",
          boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
          maxWidth: 1480,
        }}
      >
        <div
          style={{
            width: 5,
            alignSelf: "stretch",
            borderRadius: 999,
            background: accent,
            boxShadow: `0 0 16px ${accent}aa`,
            flexShrink: 0,
          }}
        />
        <div
          style={{
            fontFamily: INTER,
            fontWeight: 600,
            fontSize: 38,
            lineHeight: 1.3,
            color: COLORS.text,
            display: "flex",
            flexWrap: "wrap",
            columnGap: 11,
            rowGap: 2,
          }}
        >
          {words.map((w, i) => {
            const p = spring({
              frame: frame - delay - 6 - i * 1.6,
              fps,
              config: { damping: 16, mass: 0.5, stiffness: 150 },
            });
            return (
              <span
                key={i}
                style={{
                  display: "inline-block",
                  opacity: p,
                  transform: `translateY(${interpolate(p, [0, 1], [14, 0])}px)`,
                  color: w.hl ? accent : COLORS.text,
                  fontWeight: w.hl ? 800 : 600,
                  textShadow: w.hl ? `0 0 22px ${accent}66` : "none",
                }}
              >
                {w.text}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
};
