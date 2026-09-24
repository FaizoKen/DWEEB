import React from "react";
import { COMPONENT_META, type ComponentKind } from "../../story/rules";
import { hsla } from "../../lib/color";

/**
 * The tree's component glyphs (COMPONENT_META: ▤ ¶ ◧ ▦ ⬚ ▭ ▾ ― ⎘ ▣) drawn as
 * vector shapes. None of these code points is in the Inter subsets the film
 * loads, so rendering them as text fell back to whatever symbol font the render
 * machine had (Segoe UI Symbol here) — a different drawing on every box.
 * Shapes follow the unicode glyphs as the app shows them in its 28px tiles.
 */
const G: Record<ComponentKind, React.ReactNode> = {
  // ▤ square with horizontal fill
  container: (
    <>
      <rect x="2.6" y="2.6" width="10.8" height="10.8" rx="1" />
      <path d="M2.6 5.8h10.8M2.6 8.4h10.8M2.6 11h10.8" strokeWidth={1.05} />
    </>
  ),
  // ◧ square, left half filled
  section: (
    <>
      <rect x="2.6" y="2.6" width="10.8" height="10.8" rx="1" />
      <rect x="2.6" y="2.6" width="5.4" height="10.8" fill="currentColor" stroke="none" />
    </>
  ),
  // ¶ pilcrow
  text: (
    <>
      <path d="M8.6 3.2a2.9 2.9 0 0 0 0 5.8z" fill="currentColor" stroke="none" />
      <path d="M8.6 3.2h4.4M8.6 3.2v10.2M11.4 3.2v10.2" />
    </>
  ),
  // ▦ square with orthogonal crosshatch
  gallery: (
    <>
      <rect x="2.6" y="2.6" width="10.8" height="10.8" rx="1" />
      <path d="M6.2 2.6v10.8M9.8 2.6v10.8M2.6 6.2h10.8M2.6 9.8h10.8" strokeWidth={1.05} />
    </>
  ),
  // ⎘ page with a turned corner
  file: (
    <>
      <path d="M4.2 2.4h5.4l2.6 2.6v8.6H4.2z" />
      <path d="M9.6 2.4v2.6h2.6M6.2 8.4h4M6.2 10.8h4" strokeWidth={1.05} />
    </>
  ),
  // ― horizontal bar
  separator: <path d="M2.4 8h11.2" strokeWidth={1.5} />,
  // ⬚ dotted square
  actionRow: <rect x="2.6" y="2.6" width="10.8" height="10.8" rx="1" strokeDasharray="1.6 1.45" />,
  // ▭ white rectangle
  button: <rect x="1.8" y="4.6" width="12.4" height="6.8" rx="1.2" />,
  // ▣ square containing a small black square
  thumbnail: (
    <>
      <rect x="2.6" y="2.6" width="10.8" height="10.8" rx="1" />
      <rect x="5.4" y="5.4" width="5.2" height="5.2" fill="currentColor" stroke="none" />
    </>
  ),
  // ▾ small down-pointing triangle
  select: <path d="M4.6 6.2h6.8L8 10.6z" fill="currentColor" stroke="none" />,
};

export const ComponentGlyph: React.FC<{ kind: ComponentKind; size: number; color: string }> = ({
  kind,
  size,
  color,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke={color}
    color={color}
    strokeWidth={1.25}
    strokeLinejoin="round"
    strokeLinecap="round"
    style={{ display: "block", flexShrink: 0 }}
  >
    {G[kind]}
  </svg>
);

/**
 * The per-type tint the tree paints (ComponentTree.module.css: row fill
 * hsla(h,s,55%,.10) + a 3px inset stripe hsla(h,s,60%,.55); a selected row
 * deepens to .28 and a solid hsl(h,s,62%) stripe; the glyph tile
 * hsla(h,s,55%,.16) with a hsla(h,s,62%,.4) border and hsl(h,s,80%) ink).
 */
export function familyTint(kind: ComponentKind) {
  const { hue: h, sat: s } = COMPONENT_META[kind];
  return {
    rowFill: (selected: boolean) => hsla(h, s, 55, selected ? 0.28 : 0.1),
    rowHover: hsla(h, s, 55, 0.18),
    stripe: (selected: boolean) => (selected ? hsla(h, s, 62, 1) : hsla(h, s, 60, 0.55)),
    tileFill: (selected: boolean) => hsla(h, s, 55, selected ? 0.3 : 0.16),
    tileBorder: (selected: boolean) => (selected ? hsla(h, s, 62, 1) : hsla(h, s, 62, 0.4)),
    ink: (selected: boolean) => hsla(h, s, selected ? 88 : 80, 1),
    /** The inline editor's 3px left accent (editorPanel border-left). */
    accent: hsla(h, s, 62, 1),
  };
}
