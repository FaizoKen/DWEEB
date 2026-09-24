import React from "react";
import { INTER } from "../../fonts";

/**
 * The DWEEB app's own UI icons, path-for-path from src/ui/Icon.tsx (stroke
 * 1.75, round caps/joins, 24-unit grid). Product chrome in the film — the
 * action bar, tree chevrons, dialog headers — uses these so every glyph a
 * viewer sees matches the app they open after the film. (The film's bespoke
 * brand icons stay in components/Icon.tsx.)
 */
export type ProductIconName =
  | "plus"
  | "trash"
  | "copy"
  | "arrowUp"
  | "arrowDown"
  | "chevronRight"
  | "chevronDown"
  | "moreHorizontal"
  | "grip"
  | "send"
  | "externalLink"
  | "globe"
  | "undo"
  | "redo"
  | "history"
  | "sparkle"
  | "close"
  | "search"
  | "bookmark"
  | "save"
  | "refresh"
  | "info"
  | "bell"
  | "logIn"
  | "users"
  | "lock"
  | "checkCircle"
  | "settings"
  | "puzzle"
  | "bold"
  | "italic"
  | "underline"
  | "strike"
  | "heading"
  | "code"
  | "codeBlock"
  | "quote"
  | "listBullet"
  | "listOrdered"
  | "link"
  | "spoiler"
  | "mention"
  | "emoji"
  | "clock"
  | "hash"
  | "announcement"
  | "braces"
  | "arrowRight"
  | "forum";

const DOT = { fill: "currentColor", stroke: "none" } as const;

const PATHS: Record<ProductIconName, React.ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  trash: <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14" />,
  copy: (
    <>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </>
  ),
  arrowUp: <path d="M12 19V5M5 12l7-7 7 7" />,
  arrowDown: <path d="M12 5v14M19 12l-7 7-7-7" />,
  chevronRight: <path d="M9 6l6 6-6 6" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  moreHorizontal: (
    <g {...DOT}>
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </g>
  ),
  grip: (
    <g {...DOT}>
      {[6, 12, 18].map((y) => (
        <React.Fragment key={y}>
          <circle cx="9" cy={y} r="1.7" />
          <circle cx="15" cy={y} r="1.7" />
        </React.Fragment>
      ))}
    </g>
  ),
  send: (
    <>
      <path d="M22 2L11 13" />
      <path d="M22 2l-7 20-4-9-9-4 20-7z" />
    </>
  ),
  externalLink: (
    <>
      <path d="M15 3h6v6" />
      <path d="M10 14L21 3" />
      <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z" />
    </>
  ),
  undo: (
    <>
      <path d="M3 7v6h6" />
      <path d="M3.5 12.5A9 9 0 1 1 6 19" />
    </>
  ),
  redo: (
    <>
      <path d="M21 7v6h-6" />
      <path d="M20.5 12.5A9 9 0 1 0 18 19" />
    </>
  ),
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  sparkle: (
    <>
      <path d="M12 2.5l1.9 5.6a3 3 0 0 0 1.9 1.9l5.6 1.9-5.6 1.9a3 3 0 0 0-1.9 1.9L12 21.5l-1.9-5.6a3 3 0 0 0-1.9-1.9L2.6 12l5.6-1.9a3 3 0 0 0 1.9-1.9z" />
      <path d="M19 3.5v3M20.5 5h-3" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </>
  ),
  bookmark: <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z" />,
  save: (
    <>
      <path d="M5 3h11l3 3v15H5z" />
      <path d="M8 3v6h8V3" />
      <path d="M8 21v-7h8v7" />
    </>
  ),
  refresh: (
    <>
      <path d="M3 12a9 9 0 0 1 15.5-6.3L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15.5 6.3L3 16" />
      <path d="M3 21v-5h5" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <circle cx="12" cy="8" r="0.6" {...DOT} />
    </>
  ),
  bell: (
    <>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </>
  ),
  logIn: (
    <>
      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
      <path d="M10 17l5-5-5-5" />
      <path d="M15 12H3" />
    </>
  ),
  users: (
    <>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  lock: (
    <>
      <rect x="4.5" y="11" width="15" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  checkCircle: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.3 2.4 2.4 4.6-5.4" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
  puzzle: (
    <path d="M14.25 6.087c0-.355.186-.676.401-.959.221-.29.349-.634.349-1.003 0-1.036-1.007-1.875-2.25-1.875s-2.25.84-2.25 1.875c0 .369.128.713.349 1.003.215.283.401.604.401.959a.64.64 0 0 1-.657.643 48.39 48.39 0 0 1-4.163-.3c.186 1.613.293 3.25.315 4.907a.656.656 0 0 1-.658.663c-.355 0-.676-.186-.959-.401a1.647 1.647 0 0 0-1.003-.349c-1.036 0-1.875 1.007-1.875 2.25s.84 2.25 1.875 2.25c.369 0 .713-.128 1.003-.349.283-.215.604-.401.959-.401.31 0 .555.26.532.57a48.039 48.039 0 0 1-.642 5.056c1.518.19 3.058.309 4.616.354a.64.64 0 0 0 .657-.643c0-.355-.186-.676-.401-.959a1.647 1.647 0 0 1-.349-1.003c0-1.035 1.008-1.875 2.25-1.875 1.243 0 2.25.84 2.25 1.875 0 .369-.128.713-.349 1.003-.215.283-.4.604-.4.959 0 .333.277.599.61.58a48.1 48.1 0 0 0 5.427-.63 48.05 48.05 0 0 0 .582-4.717.532.532 0 0 0-.533-.57c-.355 0-.676.186-.959.401-.29.221-.634.349-1.003.349-1.035 0-1.875-1.007-1.875-2.25s.84-2.25 1.875-2.25c.37 0 .713.128 1.003.349.283.215.604.401.96.401a.656.656 0 0 0 .658-.663 48.422 48.422 0 0 0-.37-5.36c-1.886.342-3.81.574-5.766.689a.578.578 0 0 1-.61-.58Z" />
  ),
  // The markdown toolbar's letterform glyphs (filled text, like the app).
  bold: (
    <text x="12" y="17.5" textAnchor="middle" fontSize="17" fontWeight={800} fontFamily={INTER} {...DOT}>
      B
    </text>
  ),
  italic: (
    <text
      x="12"
      y="17.5"
      textAnchor="middle"
      fontSize="17"
      fontStyle="italic"
      fontWeight={600}
      fontFamily="Georgia, 'Times New Roman', serif"
      {...DOT}
    >
      I
    </text>
  ),
  underline: (
    <g {...DOT}>
      <text x="12" y="16" textAnchor="middle" fontSize="15" fontWeight={600} fontFamily={INTER}>
        U
      </text>
      <rect x="6" y="19" width="12" height="1.8" rx="0.9" />
    </g>
  ),
  strike: (
    <g {...DOT}>
      <text x="12" y="17.5" textAnchor="middle" fontSize="16" fontWeight={600} fontFamily={INTER}>
        S
      </text>
      <rect x="4" y="11.1" width="16" height="1.9" rx="0.95" />
    </g>
  ),
  heading: (
    <text x="12" y="17.5" textAnchor="middle" fontSize="17" fontWeight={800} fontFamily={INTER} {...DOT}>
      H
    </text>
  ),
  code: <path d="M9 8l-4 4 4 4M15 8l4 4-4 4M13.5 6l-3 12" />,
  codeBlock: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M9 10l-2 2 2 2M15 10l2 2-2 2" />
    </>
  ),
  quote: (
    <>
      <path d="M5 6v12" strokeWidth={2.5} />
      <path d="M10 8h9M10 12h9M10 16h6" />
    </>
  ),
  listBullet: (
    <>
      <path d="M9 7h11M9 12h11M9 17h11" />
      <circle cx="4.5" cy="7" r="1.1" {...DOT} />
      <circle cx="4.5" cy="12" r="1.1" {...DOT} />
      <circle cx="4.5" cy="17" r="1.1" {...DOT} />
    </>
  ),
  listOrdered: (
    <>
      <path d="M10 7h10M10 12h10M10 17h10" />
      <g {...DOT} fontSize="6.5" fontWeight={700} fontFamily={INTER}>
        <text x="2.5" y="9">1</text>
        <text x="2.5" y="14">2</text>
        <text x="2.5" y="19">3</text>
      </g>
    </>
  ),
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" />
    </>
  ),
  spoiler: (
    <>
      <path d="M3 3l18 18" />
      <path d="M10.6 10.6a2 2 0 0 0 2.83 2.83" />
      <path d="M9.4 5.2A10.3 10.3 0 0 1 12 5c5 0 9 4.5 10 7a13.6 13.6 0 0 1-2.16 3.19" />
      <path d="M6.1 6.2C3.85 7.6 2.4 9.7 2 12c1 2.5 5 7 10 7a10 10 0 0 0 3.9-.78" />
    </>
  ),
  mention: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.6 7.2" />
    </>
  ),
  emoji: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 14a4 4 0 0 0 7 0" />
      <circle cx="9" cy="10" r="0.7" {...DOT} />
      <circle cx="15" cy="10" r="0.7" {...DOT} />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  hash: <path d="M10 4 8 20M16 4l-2 16M5 9h14M4 15h14" />,
  announcement: (
    <>
      <path d="m3 11 18-5v12L3 13" />
      <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
    </>
  ),
  braces: (
    <>
      <path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1" />
      <path d="M16 21h1a2 2 0 0 0 2-2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1" />
    </>
  ),
  // "→" in "Use this template →" — drawn, since U+2192 is not in the Inter
  // subsets the film loads (a fallback font would draw it per machine).
  arrowRight: <path d="M5 12h14M13 6l6 6-6 6" />,
  forum: (
    <>
      <path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z" />
      <path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" />
    </>
  ),
};

export const PIcon: React.FC<{
  name: ProductIconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
  style?: React.CSSProperties;
}> = ({ name, size = 16, color = "currentColor", strokeWidth = 1.75, style }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    color={color}
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ flexShrink: 0, display: "block", ...style }}
  >
    {PATHS[name]}
  </svg>
);
