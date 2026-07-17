import React from "react";
import { useCurrentFrame, spring, useVideoConfig, interpolate } from "remotion";
import { COLORS } from "../theme";
import { INTER } from "../fonts";

type Part = string | { hl: string };

/**
 * Editorial super, not a transcription track. It adds one short benefit beside
 * the product footage and moves as a single designed unit, so the viewer never
 * has to read a second full sentence while also following the UI.
 */
export const Caption: React.FC<{
  parts: Part[];
  label?: string;
  delay?: number;
  out?: number; // scene-relative frame to start fading out
  accent?: string;
}> = ({ parts, label, delay = 0, out, accent = COLORS.green }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const vertical = height > width;

  const box = spring({
    frame: frame - delay,
    fps,
    config: { damping: 24, mass: 0.72, stiffness: 145 },
  });
  const exit =
    out !== undefined
      ? interpolate(frame, [out, out + 12], [1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      : 1;
  const opacity = box * exit;
  if (opacity <= 0.001) return null;

  return (
    <div
      style={{
        position: "absolute",
        bottom: vertical ? 274 : 58,
        left: vertical ? 44 : 74,
        right: vertical ? 44 : 74,
        display: "flex",
        justifyContent: "flex-start",
        opacity,
        transform: `translateY(${interpolate(box, [0, 1], [26, 0])}px)`,
        zIndex: 40,
      }}
    >
      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          gap: 7,
          background: "linear-gradient(112deg, rgba(8,9,13,.94), rgba(8,9,13,.78))",
          border: `1px solid ${COLORS.borderStrong}aa`,
          borderRadius: 16,
          padding: vertical ? "18px 22px 20px" : "16px 28px 19px",
          boxShadow: "0 22px 70px rgba(0,0,0,.48), inset 0 1px rgba(255,255,255,.035)",
          maxWidth: vertical ? 920 : 1180,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: 5,
            borderRadius: 999,
            background: accent,
            boxShadow: `0 0 22px ${accent}88`,
          }}
        />
        {label && (
          <div
            style={{
              fontFamily: INTER,
              fontSize: vertical ? 14 : 13,
              lineHeight: 1,
              letterSpacing: "0.16em",
              textTransform: "uppercase",
              fontWeight: 800,
              color: accent,
            }}
          >
            {label}
          </div>
        )}
        <div
          style={{
            fontFamily: INTER,
            fontWeight: 760,
            fontSize: vertical ? 43 : 44,
            lineHeight: 1.13,
            letterSpacing: "-0.025em",
            color: COLORS.text,
            display: "flex",
            flexWrap: "wrap",
            columnGap: 11,
            rowGap: 3,
          }}
        >
          {parts.map((part, i) => {
            const p = spring({
              frame: frame - delay - 5 - i * 3,
              fps,
              config: { damping: 22, mass: 0.55, stiffness: 160 },
            });
            const highlighted = typeof part !== "string";
            const text = typeof part === "string" ? part : part.hl;
            return (
              <span
                key={i}
                style={{
                  display: "inline-block",
                  opacity: p,
                  transform: `translateY(${interpolate(p, [0, 1], [10, 0])}px)`,
                  color: highlighted ? accent : COLORS.text,
                  fontWeight: highlighted ? 850 : 760,
                  textShadow: highlighted ? `0 0 26px ${accent}44` : "none",
                }}
              >
                {text}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
};
