/**
 * The Markdown toolbar's own glyphs (`MarkdownToolbar`).
 *
 * Kept out of `Icon.tsx` because that set is on the boot path and Rollup
 * bundles a module whole, while the toolbar only renders inside a selected
 * row's inline editor — a lazy chunk. Same 24-unit grid and `currentColor`
 * theming as the shared set.
 */

import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

const base = (size: number): SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round",
  strokeLinejoin: "round",
});

/* The inline-style marks (bold/italic/underline/strike) read most clearly as
 * letterforms, so they're filled glyphs rather than line icons. The block
 * tools stay on the shared stroked grid. */

const glyph = (size: number): SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "currentColor",
});

const GLYPH_FONT = "var(--app-font-sans), system-ui, sans-serif";

export const BoldIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...glyph(size)} {...rest}>
    <text
      x="12"
      y="17.5"
      textAnchor="middle"
      fontSize="17"
      fontWeight="800"
      fontFamily={GLYPH_FONT}
    >
      B
    </text>
  </svg>
);

export const ItalicIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...glyph(size)} {...rest}>
    <text
      x="12"
      y="17.5"
      textAnchor="middle"
      fontSize="17"
      fontStyle="italic"
      fontWeight="600"
      fontFamily="Georgia, 'Times New Roman', serif"
    >
      I
    </text>
  </svg>
);

export const UnderlineIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...glyph(size)} {...rest}>
    <text x="12" y="16" textAnchor="middle" fontSize="15" fontWeight="600" fontFamily={GLYPH_FONT}>
      U
    </text>
    <rect x="6" y="19" width="12" height="1.8" rx="0.9" />
  </svg>
);

export const StrikethroughIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...glyph(size)} {...rest}>
    <text
      x="12"
      y="17.5"
      textAnchor="middle"
      fontSize="16"
      fontWeight="600"
      fontFamily={GLYPH_FONT}
    >
      S
    </text>
    <rect x="4" y="11.1" width="16" height="1.9" rx="0.95" />
  </svg>
);

export const HeadingIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...glyph(size)} {...rest}>
    <text
      x="12"
      y="17.5"
      textAnchor="middle"
      fontSize="17"
      fontWeight="800"
      fontFamily={GLYPH_FONT}
    >
      H
    </text>
  </svg>
);

export const CodeBlockIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M9 10l-2 2 2 2M15 10l2 2-2 2" />
  </svg>
);

export const QuoteIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M5 6v12" strokeWidth={2.5} />
    <path d="M10 8h9M10 12h9M10 16h6" />
  </svg>
);

export const ListBulletIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M9 7h11M9 12h11M9 17h11" />
    <circle cx="4.5" cy="7" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="12" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="17" r="1.1" fill="currentColor" stroke="none" />
  </svg>
);

export const ListOrderedIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M10 7h10M10 12h10M10 17h10" />
    <text
      x="2.5"
      y="9"
      fontSize="6.5"
      fontWeight="700"
      fontFamily={GLYPH_FONT}
      fill="currentColor"
      stroke="none"
    >
      1
    </text>
    <text
      x="2.5"
      y="14"
      fontSize="6.5"
      fontWeight="700"
      fontFamily={GLYPH_FONT}
      fill="currentColor"
      stroke="none"
    >
      2
    </text>
    <text
      x="2.5"
      y="19"
      fontSize="6.5"
      fontWeight="700"
      fontFamily={GLYPH_FONT}
      fill="currentColor"
      stroke="none"
    >
      3
    </text>
  </svg>
);

export const SpoilerIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M3 3l18 18" />
    <path d="M10.6 10.6a2 2 0 0 0 2.83 2.83" />
    <path d="M9.4 5.2A10.3 10.3 0 0 1 12 5c5 0 9 4.5 10 7a13.6 13.6 0 0 1-2.16 3.19" />
    <path d="M6.1 6.2C3.85 7.6 2.4 9.7 2 12c1 2.5 5 7 10 7a10 10 0 0 0 3.9-.78" />
  </svg>
);
