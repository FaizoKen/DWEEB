import React from "react";
import { INTER } from "../../fonts";
import { withAlpha } from "../../lib/color";
import type { CastMember } from "../../story/campaign";

/**
 * Identities: the cast's avatars and the Nebula Gaming server icon.
 * CSS-only (no SVG gradient ids), so any number of copies can share a frame.
 */

/** A member avatar: a solid disc in the person's colour with their initial. */
export const UserAvatar: React.FC<{ person: CastMember; size: number; style?: React.CSSProperties }> = ({
  person,
  size,
  style,
}) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: "50%",
      flexShrink: 0,
      background: `linear-gradient(145deg, ${person.color}, ${withAlpha(person.color, 0.82)})`,
      color: "#fff",
      fontFamily: INTER,
      fontWeight: 800,
      fontSize: size * 0.46,
      lineHeight: 1,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      boxSizing: "border-box",
      ...style,
    }}
  >
    {person.name[0]}
  </div>
);

const STARS = [
  [18, 20, 1.6],
  [31, 12, 1.1],
  [44, 22, 1.3],
  [13, 38, 1.1],
  [26, 30, 0.9],
  [52, 42, 1.0],
  [39, 51, 0.9],
] as const;

/**
 * The Nebula Gaming server icon — the message author's avatar ({server_icon})
 * and the server badge in the Activity bar. A ringed planet on a violet night,
 * echoing the Season 4 key art, so the author reads as a gaming community
 * (never the DWEEB mascot, which is the app's own identity).
 */
export const NebulaIcon: React.FC<{
  size: number;
  /** "circle" = Discord avatar; "rounded" = server badge / composite (radius ⅓). */
  shape?: "circle" | "rounded";
  style?: React.CSSProperties;
}> = ({ size, shape = "circle", style }) => {
  const s = size / 64;
  return (
    <div
      style={{
        position: "relative",
        width: size,
        height: size,
        flexShrink: 0,
        overflow: "hidden",
        borderRadius: shape === "circle" ? "50%" : size / 3,
        background:
          "radial-gradient(90% 90% at 25% 18%, #6d4bff 0%, #3b2aa8 38%, #1a1446 78%, #120e30 100%)",
        ...style,
      }}
    >
      {STARS.map(([x, y, r], i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: (x - r) * s,
            top: (y - r) * s,
            width: 2 * r * s,
            height: 2 * r * s,
            borderRadius: "50%",
            background: "#fff",
            opacity: 0.75,
          }}
        />
      ))}
      {/* planet */}
      <div
        style={{
          position: "absolute",
          left: 22 * s,
          top: 24 * s,
          width: 30 * s,
          height: 30 * s,
          borderRadius: "50%",
          background: "radial-gradient(circle at 35% 30%, #b8ffe0 0%, #3fd6a0 34%, #1f8a8f 70%, #174a6b 100%)",
          boxShadow: `0 0 ${10 * s}px rgba(87,242,135,0.45)`,
        }}
      />
      {/* ring */}
      <div
        style={{
          position: "absolute",
          left: 9 * s,
          top: 33 * s,
          width: 56 * s,
          height: 14 * s,
          borderRadius: "50%",
          border: `${Math.max(1, 2.6 * s)}px solid rgba(236,240,255,0.92)`,
          borderTopColor: "rgba(236,240,255,0.25)",
          transform: "rotate(-18deg)",
          boxSizing: "border-box",
        }}
      />
    </div>
  );
};
