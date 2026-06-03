import type { SVGProps } from "react";

/**
 * Inline SVG icons. Sticking to a small handcoded set keeps the bundle tiny
 * and lets every icon respect `currentColor` for theming. Add to this set
 * as new builder affordances need iconography.
 */

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

export const PlusIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const TrashIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14" />
  </svg>
);

export const PencilIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
  </svg>
);

export const CopyIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
);

export const ArrowUpIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
);

export const ArrowDownIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M12 5v14M19 12l-7 7-7-7" />
  </svg>
);

export const ChevronRightIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M9 6l6 6-6 6" />
  </svg>
);

export const ChevronDownIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M6 9l6 6 6-6" />
  </svg>
);

export const ShareIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <circle cx="18" cy="5" r="3" />
    <circle cx="6" cy="12" r="3" />
    <circle cx="18" cy="19" r="3" />
    <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
  </svg>
);

export const SendIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M22 2L11 13" />
    <path d="M22 2l-7 20-4-9-9-4 20-7z" />
  </svg>
);

export const UndoIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M3 7v6h6" />
    <path d="M3.5 12.5A9 9 0 1 1 6 19" />
  </svg>
);

export const RedoIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M21 7v6h-6" />
    <path d="M20.5 12.5A9 9 0 1 0 18 19" />
  </svg>
);

export const DownloadIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M12 3v12" />
    <path d="M7 10l5 5 5-5" />
    <path d="M5 21h14" />
  </svg>
);

export const UploadIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M12 21V9" />
    <path d="M7 14l5-5 5 5" />
    <path d="M5 3h14" />
  </svg>
);

export const HistoryIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
    <path d="M12 7v5l3 2" />
  </svg>
);

export const SparkleIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M12 2.5l1.9 5.6a3 3 0 0 0 1.9 1.9l5.6 1.9-5.6 1.9a3 3 0 0 0-1.9 1.9L12 21.5l-1.9-5.6a3 3 0 0 0-1.9-1.9L2.6 12l5.6-1.9a3 3 0 0 0 1.9-1.9z" />
    <path d="M19 3.5v3M20.5 5h-3" />
  </svg>
);

export const EyeIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export const CloseIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const BookmarkIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z" />
  </svg>
);

export const SaveIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M5 3h11l3 3v15H5z" />
    <path d="M8 3v6h8V3" />
    <path d="M8 21v-7h8v7" />
  </svg>
);

export const RefreshIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M3 12a9 9 0 0 1 15.5-6.3L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-15.5 6.3L3 16" />
    <path d="M3 21v-5h5" />
  </svg>
);

export const SupportIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
    <path d="M18 19a2 2 0 0 1-2 2h-3" />
    <rect x="2" y="13" width="4" height="6" rx="1.5" />
    <rect x="18" y="13" width="4" height="6" rx="1.5" />
  </svg>
);

export const InfoIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5" />
    <circle cx="12" cy="8" r="0.6" fill="currentColor" stroke="none" />
  </svg>
);

/** Arrow entering a door — the signed-out "log in" affordance. */
export const LogInIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
    <path d="M10 17l5-5-5-5" />
    <path d="M15 12H3" />
  </svg>
);

/** Generic person — avatar fallback when a user has no Discord avatar. */
export const UserIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);

/** Padlock — pairs with the "treat the webhook URL like a password" note. */
export const LockIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <rect x="4.5" y="11" width="15" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
);

/** Error indicator — a circled exclamation. Pairs with danger color. */
export const AlertCircleIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v4.5" />
    <circle cx="12" cy="16.2" r="0.6" fill="currentColor" stroke="none" />
  </svg>
);

/** Success indicator — a circled checkmark. Pairs with success color. */
export const CheckCircleIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <circle cx="12" cy="12" r="9" />
    <path d="m8.5 12.3 2.4 2.4 4.6-5.4" />
  </svg>
);

/** Warning indicator — an exclamation triangle. Pairs with warning color. */
export const AlertTriangleIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.4 0z" />
    <path d="M12 9v4" />
    <circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none" />
  </svg>
);

export const SettingsIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

/* ── Markdown toolbar ───────────────────────────────────────────────────
 * The inline-style marks (bold/italic/underline/strike) read most clearly as
 * letterforms, so they're filled glyphs rather than line icons. The block and
 * insert tools stay on the shared stroked grid. */

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

export const CodeIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M9 8l-4 4 4 4M15 8l4 4-4 4M13.5 6l-3 12" />
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

export const LinkIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" />
    <path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" />
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

export const MentionIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <circle cx="12" cy="12" r="4" />
    <path d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.6 7.2" />
  </svg>
);

export const EmojiIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 14a4 4 0 0 0 7 0" />
    <circle cx="9" cy="10" r="0.7" fill="currentColor" stroke="none" />
    <circle cx="15" cy="10" r="0.7" fill="currentColor" stroke="none" />
  </svg>
);

export const ClockIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3.5 2" />
  </svg>
);

/** Slanted hashtag — the "channel" glyph, for the Browse Channels nav mention. */
export const HashIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <path d="M10 4 8 20M16 4l-2 16M5 9h14M4 15h14" />
  </svg>
);

/** Compass — for the Server Guide nav mention. */
export const CompassIcon = ({ size = 16, ...rest }: IconProps) => (
  <svg {...base(size)} {...rest}>
    <circle cx="12" cy="12" r="9" />
    <path d="M15.8 8.2 13.4 13.4 8.2 15.8l2.4-5.2z" />
  </svg>
);

export const LogoMark = ({ size = 22, ...rest }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 32 32" fill="none" {...rest}>
    <rect width="32" height="32" rx="9" fill="#5865F2" />
    <rect x="6" y="6" width="15" height="15" rx="5" fill="#fff" opacity="0.4" />
    <rect x="11" y="11" width="15" height="15" rx="5" fill="#fff" />
    <rect x="14" y="17" width="9" height="3" rx="1.5" fill="#57F287" />
  </svg>
);
