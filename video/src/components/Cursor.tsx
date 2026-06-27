import React from "react";

/**
 * An OS-style pointer whose *tip* lands exactly on (x, y). The arrow's hotspot
 * in the 24-unit viewBox is at (5, 3); we offset the sprite so that point sits
 * on the requested coordinate, so clicks line up with their targets.
 */
export const Cursor: React.FC<{
  x: number;
  y: number;
  pressed?: boolean;
  size?: number;
}> = ({ x, y, pressed = false, size = 32 }) => {
  const tipX = (5 / 24) * size;
  const tipY = (3 / 24) * size;

  return (
    <div
      style={{
        position: "absolute",
        left: x - tipX,
        top: y - tipY,
        transform: `scale(${pressed ? 0.82 : 1})`,
        transformOrigin: `${tipX}px ${tipY}px`,
        filter: "drop-shadow(0 4px 8px rgba(0,0,0,0.55))",
        pointerEvents: "none",
        zIndex: 30,
      }}
    >
      {pressed && (
        <div
          style={{
            position: "absolute",
            left: tipX - 22,
            top: tipY - 22,
            width: 44,
            height: 44,
            borderRadius: "50%",
            border: "2px solid rgba(87,242,135,0.9)",
            opacity: 0.7,
          }}
        />
      )}
      <svg width={size} height={size} viewBox="0 0 24 24">
        <path d="M5 3l14 7-6 1.5L9 18z" fill="#fff" stroke="#0b0d12" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
    </div>
  );
};
