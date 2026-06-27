import React from "react";
import { useCurrentFrame, spring, useVideoConfig, interpolate } from "remotion";
import { COLORS } from "../theme";
import { INTER } from "../fonts";

/**
 * The "DWEEB" wordmark with the signature green underline that wipes in,
 * echoing the og-image lockup.
 */
export const Wordmark: React.FC<{
  size?: number;
  delay?: number;
  underline?: boolean;
}> = ({ size = 180, delay = 0, underline = true }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const letters = "DWEEB".split("");

  const underlineProgress = spring({
    frame: frame - delay - 16,
    fps,
    config: { damping: 200 },
  });

  return (
    <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "center" }}>
      <div style={{ display: "flex", gap: size * 0.02 }}>
        {letters.map((ch, i) => {
          const p = spring({
            frame: frame - delay - i * 4,
            fps,
            config: { damping: 14, mass: 0.7, stiffness: 120 },
          });
          return (
            <span
              key={i}
              style={{
                fontFamily: INTER,
                fontWeight: 900,
                fontSize: size,
                lineHeight: 1,
                color: COLORS.text,
                letterSpacing: "0.02em",
                display: "inline-block",
                transform: `translateY(${interpolate(p, [0, 1], [size * 0.4, 0])}px) scale(${interpolate(p, [0, 1], [0.7, 1])})`,
                opacity: p,
                textShadow: "0 8px 40px rgba(0,0,0,0.5)",
              }}
            >
              {ch}
            </span>
          );
        })}
      </div>
      {underline && (
        <div
          style={{
            marginTop: size * 0.14,
            height: size * 0.06,
            width: size * 1.2 * underlineProgress,
            borderRadius: 999,
            background: COLORS.green,
            boxShadow: `0 0 24px ${COLORS.green}aa`,
          }}
        />
      )}
    </div>
  );
};
