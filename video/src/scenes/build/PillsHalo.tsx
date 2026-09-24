import React from "react";
import { StatPills, useUi } from "../../components/editor";
import { withAlpha } from "../../lib/color";

/**
 * "…and every limit is checked": a green ring around the MetaHeader's two
 * budget pills while they flash ✓, with one ping leaving it as the checks
 * land. The pills' 12px text is ~14 canvas px in the whole-window landscape
 * framing — too small to carry the beat on its own; the portrait master,
 * where they do read, rings them too so both cuts tell the beat alike. A film
 * flourish (the product's pills only turn green): the ring rides the pills'
 * own `ok`, so it is gone the frame they settle.
 *
 * The ring is sized by an invisible copy of the pills (same component, same
 * props, same zoom from context), so it hugs the pair exactly — ✓ icons and
 * all — without any hand-measured widths.
 */

/** The pills' "checked" green (Meta.tsx StatPill ok text / glow). */
const OK_TEXT = "#6ddf9e";
const OK_GLOW = "#2dc06b";

export const PillsHalo: React.FC<{
  /** Top-left of the pill pair, in the parent's px. */
  x: number;
  y: number;
  components: number;
  chars: number;
  /** The pills' own 0..1 ✓ state — the ring's presence, and the copy's width. */
  ok: number;
  /** Linear 0..1 time of the ping (drawn only strictly between 0 and 1). */
  ping: number;
  /** 0..1 extra bloom on the glow as the ring lands. */
  bloom?: number;
}> = ({ x, y, components, chars, ok, ping, bloom = 0 }) => {
  const { u } = useUi();
  const ring = Math.max(0, Math.min(1, ok));
  const pinging = ping > 0.001 && ping < 0.999;
  if (ring < 0.001 && !pinging) return null;
  // The ring sits 4px clear of the pills (6px inset less its 2px stroke).
  const pad = u(6);
  const ringStyle = (inset: number, alpha: number): React.CSSProperties => ({
    position: "absolute",
    inset: -inset,
    boxSizing: "border-box",
    borderRadius: 999,
    border: `${u(2)}px solid ${withAlpha(OK_TEXT, alpha)}`,
  });
  // The ping decelerates outward (cubic out) and fades on linear time, so it
  // is still seen travelling after the burst — like the cursor's click ripple.
  const spread = 1 - Math.pow(1 - ping, 3);
  return (
    <div style={{ position: "absolute", left: x, top: y, pointerEvents: "none" }}>
      <div style={{ position: "relative", display: "inline-block", verticalAlign: "top" }}>
        <div style={{ visibility: "hidden" }}>
          <StatPills components={components} chars={chars} ok={ok} />
        </div>
        {ring > 0.001 && (
          <div
            style={{
              ...ringStyle(pad, 0.9 * ring),
              // An outer glow only: box-shadow never paints inside the ring,
              // so the pills under it stay untouched.
              boxShadow: `0 0 ${u(14 + 12 * bloom)}px ${withAlpha(OK_GLOW, (0.45 + 0.25 * bloom) * ring)}`,
            }}
          />
        )}
        {pinging && <div style={ringStyle(pad + u(20) * spread, 0.85 * Math.pow(1 - ping, 1.5))} />}
      </div>
    </div>
  );
};
